// Deterministic assistant-reference extraction (spec 206).
// Only typed ACP resource blocks and explicit anchors in sealed Markdown are
// accepted. This module intentionally never scans prose or code-like text.

import type { ContentBlock } from './types';
import type { MessageResource } from './harness-view-types';
import { normalizeUrl } from './harness-markdown';

export const MAX_MESSAGE_RESOURCES = 32;

export interface ResourceMergeResult {
  resources: MessageResource[];
  overflow: number;
}

interface ResourceMetadata {
  label?: string;
  source: MessageResource['source'];
  mimeType?: string;
  size?: number;
  description?: string;
}

export function resourceFromContentBlock(
  block: ContentBlock,
  projectDir: string | null,
): MessageResource | null {
  if (block.type === 'resource_link') {
    return classifyResourceTarget(block.uri, projectDir, {
      label: cleanLabel(block.title) ?? cleanLabel(block.name),
      source: 'protocol',
      mimeType: block.mimeType,
      size: block.size,
      description: cleanLabel(block.description),
    });
  }
  if (block.type === 'resource') {
    return classifyResourceTarget(block.resource.uri, projectDir, {
      source: 'protocol',
      mimeType: block.resource.mimeType,
    });
  }
  return null;
}

export function extractResourcesFromBody(
  body: ParentNode,
  projectDir: string | null,
): MessageResource[] {
  const resources: MessageResource[] = [];
  for (const anchor of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const resource = classifyResourceTarget(anchor.getAttribute('href') ?? '', projectDir, {
      label: cleanLabel(anchor.textContent ?? ''),
      source: 'markdown',
    });
    if (resource) resources.push(resource);
  }
  return resources;
}

export function mergeMessageResources(
  existing: readonly MessageResource[],
  incoming: readonly MessageResource[],
  existingOverflow = 0,
  cap = MAX_MESSAGE_RESOURCES,
): ResourceMergeResult {
  const resources = existing.map((resource) => ({ ...resource }));
  const indexByKey = new Map(resources.map((resource, index) => [resource.key, index]));
  let overflow = existingOverflow;
  for (const candidate of incoming) {
    const index = indexByKey.get(candidate.key);
    if (index !== undefined) {
      const current = resources[index];
      if (candidate.source === 'protocol' && current.source !== 'protocol') {
        resources[index] = mergeResourceMetadata(current, candidate);
      } else if (!current.label && candidate.label) {
        resources[index] = { ...current, label: candidate.label };
      }
      continue;
    }
    if (resources.length >= cap) {
      overflow += 1;
      continue;
    }
    indexByKey.set(candidate.key, resources.length);
    resources.push({ ...candidate });
  }
  return { resources, overflow };
}

export function classifyResourceTarget(
  rawTarget: string,
  projectDir: string | null,
  metadata: ResourceMetadata,
): MessageResource | null {
  const normalized = normalizeUrl(rawTarget);
  if (!normalized || normalized.startsWith('#')) return null;

  if (/^(https?|mailto):/i.test(normalized)) {
    const target = normalizeExternalUrl(normalized);
    if (!target) return null;
    return {
      key: `url:${target}`,
      kind: 'url',
      target,
      label: metadata.label ?? urlFallbackLabel(target),
      source: metadata.source,
      mimeType: metadata.mimeType,
      size: validSize(metadata.size),
      description: metadata.description,
      hintLabel: null,
    };
  }

  let fileTarget = normalized;
  if (/^file:/i.test(fileTarget)) {
    fileTarget = fileUriToPath(fileTarget) ?? '';
  }
  if (!fileTarget) return null;

  const location = stripFileLocation(fileTarget);
  // Parse a numeric editor location before scheme rejection: `client.ts:12`
  // is a file, while `custom:thing` remains an unknown URI and is ignored.
  if (hasUriScheme(location.path) && !isWindowsAbsolute(location.path)) return null;
  const absolutePath = resolveFilePath(location.path, projectDir);
  if (!absolutePath) return null;
  const display = projectRelativePath(absolutePath, projectDir);
  return {
    key: `file:${absolutePath}:${location.line ?? ''}:${location.column ?? ''}`,
    kind: 'file',
    target: absolutePath,
    label: metadata.label ?? display,
    source: metadata.source,
    line: location.line,
    column: location.column,
    mimeType: metadata.mimeType,
    size: validSize(metadata.size),
    description: metadata.description,
    hintLabel: null,
  };
}

export function resourceDisplayTarget(resource: MessageResource, projectDir: string | null): string {
  const target = resource.kind === 'file'
    ? projectRelativePath(resource.target, projectDir)
    : resource.target;
  const location = resource.line
    ? `:${resource.line}${resource.column ? `:${resource.column}` : ''}`
    : '';
  return `${target}${location}`;
}

function mergeResourceMetadata(current: MessageResource, protocol: MessageResource): MessageResource {
  return {
    ...current,
    ...protocol,
    label: protocol.label || current.label,
    line: protocol.line ?? current.line,
    column: protocol.column ?? current.column,
    mimeType: protocol.mimeType ?? current.mimeType,
    size: protocol.size ?? current.size,
    description: protocol.description ?? current.description,
    source: 'protocol',
    hintLabel: current.hintLabel,
  };
}

function normalizeExternalUrl(value: string): string | null {
  if (/^mailto:/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function urlFallbackLabel(value: string): string {
  if (/^mailto:/i.test(value)) return value;
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

function fileUriToPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || (url.host && url.host !== 'localhost')) return null;
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return `${path}${url.hash}`;
  } catch {
    return null;
  }
}

function stripFileLocation(value: string): { path: string; line?: number; column?: number } {
  const hash = value.match(/#L(\d+)(?::(\d+))?$/i);
  if (hash?.index !== undefined) {
    return {
      path: value.slice(0, hash.index),
      line: Number(hash[1]),
      column: hash[2] ? Number(hash[2]) : undefined,
    };
  }
  const suffix = value.match(/:(\d+)(?::(\d+))?$/);
  if (suffix?.index !== undefined && !(suffix.index === 1 && isWindowsAbsolute(value))) {
    return {
      path: value.slice(0, suffix.index),
      line: Number(suffix[1]),
      column: suffix[2] ? Number(suffix[2]) : undefined,
    };
  }
  return { path: value };
}

function resolveFilePath(value: string, projectDir: string | null): string | null {
  const slashPath = value.replace(/\\/g, '/');
  if (slashPath.startsWith('/') || isWindowsAbsolute(slashPath)) return normalizePath(slashPath);
  if (!projectDir) return null;
  return normalizePath(`${projectDir.replace(/\/$/, '')}/${slashPath}`);
}

function normalizePath(value: string): string {
  const windowsPrefix = value.match(/^[A-Za-z]:\//)?.[0] ?? '';
  const absolute = value.startsWith('/') || windowsPrefix.length > 0;
  const source = windowsPrefix ? value.slice(windowsPrefix.length) : value.replace(/^\//, '');
  const parts: string[] = [];
  for (const part of source.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (windowsPrefix) return `${windowsPrefix}${parts.join('/')}`;
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}

function projectRelativePath(path: string, projectDir: string | null): string {
  if (!projectDir) return path;
  const root = normalizePath(projectDir).replace(/\/$/, '');
  if (path === root) return '.';
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function hasUriScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function cleanLabel(value: string | undefined): string | undefined {
  const clean = value?.replace(/\s+/g, ' ').trim();
  return clean || undefined;
}

function validSize(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
