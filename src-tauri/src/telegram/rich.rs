use super::{split_message, MESSAGE_LIMIT};
use comrak::nodes::{AstNode, ListType, NodeList, NodeTable, NodeValue, TableAlignment};
use comrak::{parse_document, Arena, Options};

const RICH_MAX_BYTES: usize = 24_000;
const RICH_MAX_BLOCKS: usize = 450;
const RICH_MAX_DEPTH: usize = 14;
const PREVIEW_MAX_BYTES: usize = 8_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TelegramOutputChunk {
    Rich { html: String, plain: String },
    Plain { text: String },
}

impl TelegramOutputChunk {
    pub(crate) fn plain(&self) -> &str {
        match self {
            Self::Rich { plain, .. } => plain,
            Self::Plain { text } => text,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct Rendered {
    html: String,
    plain: String,
    blocks: usize,
    depth: usize,
}

impl Rendered {
    fn inline(html: String, plain: String) -> Self {
        Self {
            html,
            plain,
            blocks: 0,
            depth: 0,
        }
    }

    fn block(open: &str, close: &str, inner: Self) -> Self {
        Self {
            html: format!("{open}{}{close}", inner.html),
            plain: inner.plain,
            blocks: inner.blocks + 1,
            depth: inner.depth + 1,
        }
    }

    fn combine(parts: impl IntoIterator<Item = Self>, separator: &str) -> Self {
        let mut combined = Self::default();
        for part in parts {
            if !combined.html.is_empty() && !part.html.is_empty() {
                combined.html.push_str(separator);
            }
            if !combined.plain.is_empty() && !part.plain.is_empty() {
                combined.plain.push_str(separator);
            }
            combined.html.push_str(&part.html);
            combined.plain.push_str(&part.plain);
            combined.blocks += part.blocks;
            combined.depth = combined.depth.max(part.depth);
        }
        combined
    }
}

enum Fragment {
    Rich(Rendered),
    Plain(String),
}

pub(crate) fn render_rich_preview(markdown: &str) -> Result<String, String> {
    let preview = utf8_tail(markdown, PREVIEW_MAX_BYTES);
    render_rich_chunks(preview)
        .into_iter()
        .next_back()
        .ok_or_else(|| "Telegram rich preview is empty".to_string())
        .and_then(|chunk| match chunk {
            TelegramOutputChunk::Rich { html, .. } => Ok(html),
            TelegramOutputChunk::Plain { .. } => {
                Err("Telegram rich preview exceeded safe limits".to_string())
            }
        })
}

pub(crate) fn render_rich_chunks(markdown: &str) -> Vec<TelegramOutputChunk> {
    if markdown.trim().is_empty() {
        return Vec::new();
    }
    let arena = Arena::new();
    let options = rich_options();
    let root = parse_document(&arena, markdown, &options);
    let fragments = root
        .children()
        .flat_map(split_node)
        .collect::<Vec<Fragment>>();
    combine_fragments(fragments)
}

fn rich_options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.render.r#unsafe = false;
    options.render.escape = true;
    options
}

fn split_node<'a>(node: &'a AstNode<'a>) -> Vec<Fragment> {
    let value = node.data.borrow().value.clone();
    let rendered = render_node(node);
    if matches!(&value, NodeValue::Table(table) if table.num_columns > 20) {
        return plain_fragments(&rendered.plain);
    }
    if fits(&rendered) {
        return vec![Fragment::Rich(rendered)];
    }
    match value {
        NodeValue::List(list) => split_list(node, list),
        NodeValue::Table(table) => split_table(node, &table),
        NodeValue::BlockQuote => split_blockquote(node),
        _ => plain_fragments(&rendered.plain),
    }
}

fn split_list<'a>(node: &'a AstNode<'a>, list: NodeList) -> Vec<Fragment> {
    let mut output = Vec::new();
    let mut group = Vec::new();
    let mut group_start_index = 0_usize;

    for (item_index, child) in node.children().enumerate() {
        let item = render_node(child);
        let group_start = list.start.saturating_add(group_start_index);
        let candidate = wrap_list(&list, group_start, combine_with(group.iter(), &item));
        if fits(&candidate) {
            group.push(item);
            continue;
        }
        flush_list_group(&mut output, &mut group, &list, group_start);
        group_start_index = item_index;
        let group_start = list.start.saturating_add(group_start_index);
        let single = wrap_list(&list, group_start, item.clone());
        if fits(&single) {
            group.push(item);
        } else {
            output.extend(plain_fragments(&item.plain));
            group_start_index = item_index.saturating_add(1);
        }
    }
    let group_start = list.start.saturating_add(group_start_index);
    flush_list_group(&mut output, &mut group, &list, group_start);
    output
}

fn flush_list_group(
    output: &mut Vec<Fragment>,
    group: &mut Vec<Rendered>,
    list: &NodeList,
    start: usize,
) {
    if group.is_empty() {
        return;
    }
    let inner = Rendered::combine(std::mem::take(group), "");
    output.push(Fragment::Rich(wrap_list(list, start, inner)));
}

fn wrap_list(list: &NodeList, start: usize, inner: Rendered) -> Rendered {
    match list.list_type {
        ListType::Bullet => Rendered::block("<ul>", "</ul>", inner),
        ListType::Ordered if start > 1 => {
            Rendered::block(&format!("<ol start=\"{start}\">"), "</ol>", inner)
        }
        ListType::Ordered => Rendered::block("<ol>", "</ol>", inner),
    }
}

fn split_table<'a>(node: &'a AstNode<'a>, table: &NodeTable) -> Vec<Fragment> {
    if table.num_columns > 20 {
        return plain_fragments(&render_node(node).plain);
    }
    let rows = node.children().collect::<Vec<_>>();
    let header = rows
        .first()
        .filter(|row| matches!(row.data.borrow().value, NodeValue::TableRow(true)))
        .map(|row| render_table_row(row, true, &table.alignments));
    let body_start = usize::from(header.is_some());
    let mut output = Vec::new();
    let mut group = Vec::new();

    for row in rows.into_iter().skip(body_start) {
        let rendered_row = render_table_row(row, false, &table.alignments);
        let candidate = wrap_table(header.as_ref(), combine_with(group.iter(), &rendered_row));
        if fits(&candidate) {
            group.push(rendered_row);
            continue;
        }
        flush_table_group(&mut output, &mut group, header.as_ref());
        let single = wrap_table(header.as_ref(), rendered_row.clone());
        if fits(&single) {
            group.push(rendered_row);
        } else {
            output.extend(plain_fragments(&rendered_row.plain));
        }
    }
    flush_table_group(&mut output, &mut group, header.as_ref());
    if output.is_empty() {
        let header_only = wrap_table(header.as_ref(), Rendered::default());
        if fits(&header_only) {
            output.push(Fragment::Rich(header_only));
        }
    }
    output
}

fn flush_table_group(
    output: &mut Vec<Fragment>,
    group: &mut Vec<Rendered>,
    header: Option<&Rendered>,
) {
    if group.is_empty() {
        return;
    }
    let body = Rendered::combine(std::mem::take(group), "");
    output.push(Fragment::Rich(wrap_table(header, body)));
}

fn wrap_table(header: Option<&Rendered>, body: Rendered) -> Rendered {
    let mut parts = Vec::new();
    if let Some(header) = header {
        parts.push(header.clone());
    }
    parts.push(body);
    Rendered::block("<table>", "</table>", Rendered::combine(parts, ""))
}

fn split_blockquote<'a>(node: &'a AstNode<'a>) -> Vec<Fragment> {
    let mut output = Vec::new();
    let mut group = Vec::new();
    for child in node.children() {
        for fragment in split_node(child) {
            match fragment {
                Fragment::Rich(rendered) => {
                    let candidate = Rendered::block(
                        "<blockquote>",
                        "</blockquote>",
                        combine_with(group.iter(), &rendered),
                    );
                    if fits(&candidate) {
                        group.push(rendered);
                    } else {
                        flush_blockquote_group(&mut output, &mut group);
                        let single =
                            Rendered::block("<blockquote>", "</blockquote>", rendered.clone());
                        if fits(&single) {
                            group.push(rendered);
                        } else {
                            output.extend(plain_fragments(&rendered.plain));
                        }
                    }
                }
                Fragment::Plain(text) => {
                    flush_blockquote_group(&mut output, &mut group);
                    output.push(Fragment::Plain(text));
                }
            }
        }
    }
    flush_blockquote_group(&mut output, &mut group);
    output
}

fn flush_blockquote_group(output: &mut Vec<Fragment>, group: &mut Vec<Rendered>) {
    if group.is_empty() {
        return;
    }
    output.push(Fragment::Rich(Rendered::block(
        "<blockquote>",
        "</blockquote>",
        Rendered::combine(std::mem::take(group), "\n"),
    )));
}

fn combine_with<'a>(current: impl Iterator<Item = &'a Rendered>, next: &Rendered) -> Rendered {
    Rendered::combine(current.cloned().chain(std::iter::once(next.clone())), "")
}

fn combine_fragments(fragments: Vec<Fragment>) -> Vec<TelegramOutputChunk> {
    let mut output = Vec::new();
    let mut current = Rendered::default();
    for fragment in fragments {
        match fragment {
            Fragment::Rich(rendered) => {
                let candidate = Rendered::combine([current.clone(), rendered.clone()], "\n");
                if current.html.is_empty() || fits(&candidate) {
                    current = candidate;
                } else {
                    push_rich(&mut output, std::mem::take(&mut current));
                    current = rendered;
                }
            }
            Fragment::Plain(text) => {
                push_rich(&mut output, std::mem::take(&mut current));
                output.push(TelegramOutputChunk::Plain { text });
            }
        }
    }
    push_rich(&mut output, current);
    output
}

fn push_rich(output: &mut Vec<TelegramOutputChunk>, rendered: Rendered) {
    if rendered.html.is_empty() {
        return;
    }
    output.push(TelegramOutputChunk::Rich {
        html: rendered.html,
        plain: rendered.plain,
    });
}

fn plain_fragments(text: &str) -> Vec<Fragment> {
    split_message(text, MESSAGE_LIMIT)
        .into_iter()
        .map(Fragment::Plain)
        .collect()
}

fn fits(rendered: &Rendered) -> bool {
    rendered.html.len() <= RICH_MAX_BYTES
        && rendered.blocks <= RICH_MAX_BLOCKS
        && rendered.depth <= RICH_MAX_DEPTH
}

fn render_node<'a>(node: &'a AstNode<'a>) -> Rendered {
    let value = node.data.borrow().value.clone();
    match value {
        NodeValue::Document => render_block_children(node),
        NodeValue::Paragraph => Rendered::block("<p>", "</p>", render_inline_children(node)),
        NodeValue::Heading(heading) => {
            let tag = format!("h{}", heading.level.clamp(1, 6));
            Rendered::block(
                &format!("<{tag}>"),
                &format!("</{tag}>"),
                render_inline_children(node),
            )
        }
        NodeValue::ThematicBreak => Rendered {
            html: "<hr/>".to_string(),
            plain: "—".to_string(),
            blocks: 1,
            depth: 1,
        },
        NodeValue::CodeBlock(code) => {
            let language = code
                .info
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '+' | '-'))
                .collect::<String>();
            let html = if language.is_empty() {
                format!("<pre>{}</pre>", escape_text(&code.literal))
            } else {
                format!(
                    "<pre><code class=\"language-{}\">{}</code></pre>",
                    escape_attribute(&language),
                    escape_text(&code.literal)
                )
            };
            Rendered {
                html,
                plain: code.literal,
                blocks: 1,
                depth: 1,
            }
        }
        NodeValue::HtmlBlock(block) => Rendered {
            html: format!("<pre>{}</pre>", escape_text(&block.literal)),
            plain: block.literal,
            blocks: 1,
            depth: 1,
        },
        NodeValue::FrontMatter(text) => Rendered {
            html: format!("<pre>{}</pre>", escape_text(&text)),
            plain: text,
            blocks: 1,
            depth: 1,
        },
        NodeValue::BlockQuote => {
            Rendered::block("<blockquote>", "</blockquote>", render_block_children(node))
        }
        NodeValue::List(list) => {
            let inner = Rendered::combine(node.children().map(render_node), "");
            wrap_list(&list, list.start, inner)
        }
        NodeValue::Item(_) => Rendered::block("<li>", "</li>", render_block_children(node)),
        NodeValue::TaskItem(task) => {
            let marker = if task.symbol.is_some() {
                "☑ "
            } else {
                "☐ "
            };
            let mut inner = render_block_children(node);
            inner.html.insert_str(0, marker);
            inner.plain.insert_str(0, marker);
            Rendered::block("<li>", "</li>", inner)
        }
        NodeValue::Table(table) => render_table(node, &table),
        NodeValue::TableRow(header) => render_table_row(node, header, &[]),
        NodeValue::TableCell => Rendered::block("<td>", "</td>", render_inline_children(node)),
        NodeValue::Text(text) => {
            let text = text.into_owned();
            Rendered::inline(escape_text(&text), text)
        }
        NodeValue::SoftBreak => Rendered::inline("\n".to_string(), "\n".to_string()),
        NodeValue::LineBreak => Rendered::inline("<br/>".to_string(), "\n".to_string()),
        NodeValue::Code(code) => Rendered::inline(
            format!("<code>{}</code>", escape_text(&code.literal)),
            code.literal,
        ),
        NodeValue::HtmlInline(text) | NodeValue::Raw(text) => {
            Rendered::inline(escape_text(&text), text)
        }
        NodeValue::Emph => inline_wrapper(node, "<em>", "</em>"),
        NodeValue::Strong => inline_wrapper(node, "<strong>", "</strong>"),
        NodeValue::Strikethrough => inline_wrapper(node, "<del>", "</del>"),
        NodeValue::Link(link) => render_link(node, &link.url),
        NodeValue::Image(link) => render_image(node, &link.url),
        NodeValue::FootnoteReference(reference) => {
            let text = format!("[^{}]", reference.name);
            Rendered::inline(escape_text(&text), text)
        }
        NodeValue::Math(math) => Rendered::inline(escape_text(&math.literal), math.literal),
        _ => render_inline_children(node),
    }
}

fn render_table<'a>(node: &'a AstNode<'a>, table: &NodeTable) -> Rendered {
    let rows = node.children().map(|row| {
        let header = matches!(row.data.borrow().value, NodeValue::TableRow(true));
        render_table_row(row, header, &table.alignments)
    });
    Rendered::block("<table>", "</table>", Rendered::combine(rows, ""))
}

fn render_table_row<'a>(
    node: &'a AstNode<'a>,
    header: bool,
    alignments: &[TableAlignment],
) -> Rendered {
    let mut cells = Vec::new();
    for (index, cell) in node.children().enumerate() {
        let inner = render_inline_children(cell);
        let tag = if header { "th" } else { "td" };
        let align = match alignments
            .get(index)
            .copied()
            .unwrap_or(TableAlignment::None)
        {
            TableAlignment::Left => " align=\"left\"",
            TableAlignment::Center => " align=\"center\"",
            TableAlignment::Right => " align=\"right\"",
            TableAlignment::None => "",
        };
        cells.push(Rendered::block(
            &format!("<{tag}{align}>"),
            &format!("</{tag}>"),
            inner,
        ));
    }
    let mut inner = Rendered::combine(cells, "");
    inner.plain = node
        .children()
        .map(|cell| render_inline_children(cell).plain)
        .collect::<Vec<_>>()
        .join(" | ");
    Rendered::block("<tr>", "</tr>", inner)
}

fn render_link<'a>(node: &'a AstNode<'a>, url: &str) -> Rendered {
    let mut inner = render_inline_children(node);
    if safe_url(url) {
        inner.html = format!("<a href=\"{}\">{}</a>", escape_attribute(url), inner.html);
    } else if !url.is_empty() {
        inner.html.push_str(&format!(" ({})", escape_text(url)));
        inner.plain.push_str(&format!(" ({url})"));
    }
    inner
}

fn render_image<'a>(node: &'a AstNode<'a>, url: &str) -> Rendered {
    let mut inner = render_inline_children(node);
    if inner.plain.trim().is_empty() {
        inner.html = "image".to_string();
        inner.plain = "image".to_string();
    }
    if !url.is_empty() {
        inner.html.push_str(&format!(" ({})", escape_text(url)));
        inner.plain.push_str(&format!(" ({url})"));
    }
    inner
}

fn inline_wrapper<'a>(node: &'a AstNode<'a>, open: &str, close: &str) -> Rendered {
    let mut inner = render_inline_children(node);
    inner.html = format!("{open}{}{close}", inner.html);
    inner
}

fn render_block_children<'a>(node: &'a AstNode<'a>) -> Rendered {
    Rendered::combine(node.children().map(render_node), "\n")
}

fn render_inline_children<'a>(node: &'a AstNode<'a>) -> Rendered {
    Rendered::combine(node.children().map(render_node), "")
}

fn safe_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    ["https://", "http://", "mailto:", "tel:"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attribute(text: &str) -> String {
    escape_text(text).replace('"', "&quot;")
}

fn utf8_tail(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_supported_gfm_as_telegram_html() {
        let chunks = render_rich_chunks(
            "# Heading\n\n- [x] done\n- [ ] todo\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```rust\nlet x = 1;\n```",
        );
        assert_eq!(chunks.len(), 1);
        let TelegramOutputChunk::Rich { html, .. } = &chunks[0] else {
            panic!("expected rich output");
        };
        assert!(html.contains("<h1>Heading</h1>"));
        assert!(html.contains("<li>☑ "));
        assert!(html.contains("<table>"));
        assert!(html.contains("<th>A</th>"));
        assert!(html.contains("<code class=\"language-rust\">"));
    }

    #[test]
    fn escapes_raw_html_and_never_emits_images_or_unsafe_links() {
        let chunks = render_rich_chunks(
            "<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![secret](file:///tmp/a.png)",
        );
        let TelegramOutputChunk::Rich { html, .. } = &chunks[0] else {
            panic!("expected rich output");
        };
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("<script>"));
        assert!(!html.contains("href=\"javascript:"));
        assert!(!html.contains("<img"));
        assert!(html.contains("file:///tmp/a.png"));
    }

    #[test]
    fn preserves_literal_dollar_amounts_in_html_mode() {
        let chunks = render_rich_chunks("Budget: $400-600K.");
        let TelegramOutputChunk::Rich { html, .. } = &chunks[0] else {
            panic!("expected rich output");
        };
        assert!(html.contains("$400-600K"));
        assert!(!html.contains("tg-math"));
    }

    #[test]
    fn splits_large_lists_by_nested_block_budget() {
        let markdown = (0..500)
            .map(|index| format!("- item {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let chunks = render_rich_chunks(&markdown);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| match chunk {
            TelegramOutputChunk::Rich { html, .. } => html.len() <= RICH_MAX_BYTES,
            TelegramOutputChunk::Plain { .. } => false,
        }));
    }

    #[test]
    fn split_ordered_lists_continue_the_item_number() {
        let markdown = (1..=500)
            .map(|index| format!("{index}. item {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let chunks = render_rich_chunks(&markdown);
        assert!(chunks.len() > 1);
        let TelegramOutputChunk::Rich { html, .. } = &chunks[1] else {
            panic!("expected rich continuation");
        };
        assert!(html.contains("<ol start=\""));
        assert!(!html.contains("<ol start=\"1\""));
    }

    #[test]
    fn unsafe_table_width_and_depth_fall_back_to_plain() {
        let header = (0..21)
            .map(|index| format!("H{index}"))
            .collect::<Vec<_>>()
            .join(" | ");
        let separator = (0..21).map(|_| "---").collect::<Vec<_>>().join(" | ");
        let row = (0..21)
            .map(|index| index.to_string())
            .collect::<Vec<_>>()
            .join(" | ");
        let table = format!("| {header} |\n| {separator} |\n| {row} |");
        assert!(render_rich_chunks(&table)
            .iter()
            .all(|chunk| matches!(chunk, TelegramOutputChunk::Plain { .. })));

        let deep = (0..20)
            .map(|depth| format!("{}- level {depth}", "  ".repeat(depth)))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(render_rich_chunks(&deep)
            .iter()
            .any(|chunk| matches!(chunk, TelegramOutputChunk::Plain { .. })));
    }

    #[test]
    fn uses_utf8_byte_budget_for_unicode() {
        let markdown = (0..2_000)
            .map(|index| format!("ย่อหน้าที่ {index} ภาษาไทย"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let chunks = render_rich_chunks(&markdown);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| match chunk {
            TelegramOutputChunk::Rich { html, .. } => html.len() <= RICH_MAX_BYTES,
            TelegramOutputChunk::Plain { text } => text.chars().count() <= MESSAGE_LIMIT,
        }));
    }

    #[test]
    fn preview_uses_a_valid_utf8_tail() {
        let markdown = format!("{}# Final", "ก".repeat(PREVIEW_MAX_BYTES));
        let preview = render_rich_preview(&markdown).expect("rich preview");
        assert!(preview.contains("Final"));
    }
}
