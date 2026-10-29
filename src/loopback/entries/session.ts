// Spec 341 — `/app/session/<token>?next=<path>`: the server already checked the
// token and `next`; store the capability and move on without a history entry.

import '../styles/base.css';

import { isSameOriginPath, sessionTokenFromPath, storeSessionToken } from '../kit/lib/session';

const token = sessionTokenFromPath(location.pathname);
const next = new URLSearchParams(location.search).get('next') ?? '/';
if (token) storeSessionToken(token);
location.replace(isSameOriginPath(next) ? next : '/');
