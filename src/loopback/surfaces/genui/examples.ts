// Fixed, local examples for the loopback GenUI gallery (spec 313).
// Each source goes through the production compiler and renderer; no project data is read.

export interface GalleryExample {
  readonly component: string;
  readonly source: string;
}

export const EXAMPLES: readonly GalleryExample[] = [
  { component: 'Card', source: 'Card("Build summary", [Text("All checks passed"), Metric("Duration", "42 s")])' },
  { component: 'Row', source: 'Row([Metric("Passed", "28", tone: "good"), Metric("Failed", "0")])' },
  { component: 'Stack', source: 'Stack([Text("Compile"), Text("Test"), Text("Package")])' },
  { component: 'Grid', source: 'Grid([Metric("Builds", "12"), Metric("Branches", "3"), Metric("Alerts", "1")], 2)' },
  { component: 'Tabs', source: 'Tabs(["Summary", "Details"], [Text("28 checks passed"), Text("No failures in the latest run")])' },
  { component: 'Details', source: 'Details("Build details", [Text("Compiled in 42 seconds")], open: true)' },
  { component: 'Divider', source: 'Stack([Text("Before"), Divider(), Text("After")])' },

  { component: 'Text', source: 'Text("**Ready** to ship the next build.", tone: "good")' },
  { component: 'Callout', source: 'Callout("Review the changed files before release.", tone: "warn", title: "Review")' },
  { component: 'Metric', source: 'Metric("Coverage", "92%", note: "+3 points", tone: "good")' },
  { component: 'Badge', source: 'Badge("passing", tone: "good")' },
  { component: 'KeyValue', source: 'KeyValue({ branch: "main", commit: "a1b2c3", checks: 28 })' },
  { component: 'List', source: 'List([{ title: "Parser", detail: "Unit tests", value: "passed", tone: "good" }, { title: "Renderer", detail: "Browser check", value: "pending", tone: "warn" }])' },
  { component: 'Sources', source: 'Sources([{ url: "https://example.com/docs", title: "Documentation", note: "Example link" }])' },

  { component: 'Table', source: 'Table(["Check", "Result"], [["Compiler", "Pass"], ["Renderer", "Pass"], ["Browser", "Pending"]])' },
  { component: 'Chart', source: 'Chart("bar", ["Mon", "Tue", "Wed", "Thu"], [4, 7, 5, 9], unit: "runs")' },
  { component: 'Sparkline', source: 'Sparkline([3, 5, 4, 8, 6, 9], tone: "good")' },
  { component: 'Progress', source: 'Progress(72, label: "Migration", tone: "good")' },
  { component: 'Gauge', source: 'Gauge(82, label: "Health", tone: "good")' },
  { component: 'SegmentedBar', source: 'SegmentedBar([{ label: "Passed", value: 24, tone: "good" }, { label: "Pending", value: 4, tone: "warn" }], unit: "checks")' },
  { component: 'Steps', source: 'Steps([{ title: "Compile", status: "done" }, { title: "Test", status: "current" }, { title: "Package", status: "blocked" }])' },
  { component: 'Timeline', source: 'Timeline([{ time: "09:10", title: "Build started" }, { time: "09:12", title: "Checks passed", tone: "good" }])' },
  { component: 'Tree', source: 'Tree([{ label: "src", children: [{ label: "acp" }, { label: "ui" }] }, { label: "docs" }])' },
  { component: 'Code', source: 'Code("const ready = true;", language: "ts")' },
  { component: 'Diff', source: String.raw`Diff("@@ -1 +1 @@\n-old\n+new", path: "src/state.ts")` },
  { component: 'Diagram', source: 'Diagram("flowchart LR; A[Start] --> B[Done]")' },

  { component: 'Slider', source: '$seats = 4\nSlider($seats, 1, 20, label: "Seats")' },
  { component: 'Stepper', source: '$retries = 2\nStepper($retries, min: 0, max: 5, label: "Retries")' },
  { component: 'Toggle', source: '$enabled = true\nToggle($enabled, "Notifications")' },
  { component: 'Choice', source: '$plan = "Pro"\nChoice($plan, ["Basic", "Pro", "Team"], label: "Plan")' },
  { component: 'Radio', source: '$region = "East"\nRadio($region, ["East", "West"], label: "Region")' },
  { component: 'Select', source: '$env = "Staging"\nSelect($env, ["Development", "Staging", "Production"], label: "Environment")' },
  { component: 'Checklist', source: '$checks = ["Type check"]\nChecklist($checks, ["Type check", "Unit tests", "Browser smoke"], label: "Checks")' },
  { component: 'Input', source: '$name = "Krypton"\nInput($name, label: "Project", placeholder: "Name")' },
  { component: 'TextArea', source: '$notes = "Ready for review"\nTextArea($notes, label: "Notes", placeholder: "Add notes")' },
  { component: 'Rating', source: '$score = 3\nRating($score, max: 5, label: "Experience")' },
  { component: 'EditableTable', source: '$rows = [{ Name: "Parser", Hours: 2 }, { Name: "Renderer", Hours: 4 }]\nEditableTable($rows, ["Name", "Hours"], label: "Work")' },
  { component: 'Button', source: 'Button("Copy summary", Copy("All checks passed"), variant: "primary")' },

  { component: 'Form', source: '$name = "Krypton"\n$plan = "Pro"\nForm([Input($name, label: "Project"), Select($plan, ["Basic", "Pro"], label: "Plan")], submit: "Prepare draft")' },
  { component: 'FollowUps', source: 'FollowUps(["Show failures", "Compare with last run", "Open the report"])' },
];
