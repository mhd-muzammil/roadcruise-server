import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { JsonStore } from "../../notifications/repository/store.js";
import { config } from "../config/auth.config.js";

/**
 * Enterprise session store. One record per (user, device) login. Backed by the
 * shared atomic JsonStore in its own data dir. Tracks device/browser/IP and
 * supports remote logout (single session, all sessions, admin revoke).
 *
 * Session shape:
 *   { sessionId, userEmail, provider, device, browser, os, ip, userAgent,
 *     refreshJti, createdAt, lastActive, expiresAt, revoked, revokedAt, revokedBy }
 */
const AUTH_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data");
const store = new JsonStore("sessions.json", { sessions: [] }, AUTH_DATA_DIR);

/** Best-effort device/browser/OS parse from a User-Agent (no dependency). */
export function parseUserAgent(ua = "") {
  const s = String(ua);
  const browser =
    /Edg\//.test(s) ? "Edge" :
    /OPR\/|Opera/.test(s) ? "Opera" :
    /Chrome\//.test(s) ? "Chrome" :
    /Firefox\//.test(s) ? "Firefox" :
    /Safari\//.test(s) ? "Safari" : "Unknown";
  const os =
    /Windows/.test(s) ? "Windows" :
    /Android/.test(s) ? "Android" :
    /iPhone|iPad|iOS/.test(s) ? "iOS" :
    /Mac OS X|Macintosh/.test(s) ? "macOS" :
    /Linux/.test(s) ? "Linux" : "Unknown";
  const device = /Mobile|Android|iPhone/.test(s) ? "Mobile" : "Desktop";
  return { browser, os, device };
}

export async function createSession({ userEmail, provider = "local", ip, userAgent, refreshJti, ttlSec = config.refreshTtlSec }) {
  const { browser, os, device } = parseUserAgent(userAgent);
  const now = Date.now();
  const session = {
    sessionId: `sess_${randomUUID().replace(/-/g, "")}`,
    userEmail: String(userEmail).toLowerCase(),
    provider,
    device,
    browser,
    os,
    ip: ip || null,
    userAgent: userAgent || null,
    refreshJti: refreshJti || null,
    createdAt: new Date(now).toISOString(),
    lastActive: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSec * 1000).toISOString(),
    revoked: false,
    revokedAt: null,
    revokedBy: null,
  };
  await store.update((db) => db.sessions.push(session));
  return session;
}

export function findById(sessionId) {
  return store.read().sessions.find((s) => s.sessionId === sessionId) || null;
}

export function isActive(session) {
  return !!session && !session.revoked && new Date(session.expiresAt).getTime() > Date.now();
}

export function listForUser(userEmail, { includeInactive = false } = {}) {
  const email = String(userEmail).toLowerCase();
  return store
    .read()
    .sessions.filter((s) => s.userEmail === email && (includeInactive || isActive(s)))
    .sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
}

export async function touch(sessionId) {
  return store.update((db) => {
    const s = db.sessions.find((x) => x.sessionId === sessionId);
    if (s) s.lastActive = new Date().toISOString();
    return s || null;
  });
}

export async function rotateJti(sessionId, newJti) {
  return store.update((db) => {
    const s = db.sessions.find((x) => x.sessionId === sessionId);
    if (s) {
      s.refreshJti = newJti;
      s.lastActive = new Date().toISOString();
    }
    return s || null;
  });
}

export async function revoke(sessionId, revokedBy = "user") {
  return store.update((db) => {
    const s = db.sessions.find((x) => x.sessionId === sessionId);
    if (s && !s.revoked) {
      s.revoked = true;
      s.revokedAt = new Date().toISOString();
      s.revokedBy = revokedBy;
    }
    return s || null;
  });
}

export async function revokeAllForUser(userEmail, revokedBy = "user", exceptSessionId = null) {
  const email = String(userEmail).toLowerCase();
  return store.update((db) => {
    let count = 0;
    for (const s of db.sessions) {
      if (s.userEmail === email && !s.revoked && s.sessionId !== exceptSessionId) {
        s.revoked = true;
        s.revokedAt = new Date().toISOString();
        s.revokedBy = revokedBy;
        count += 1;
      }
    }
    return count;
  });
}

/** Public-safe projection (no jti / ua noise) for the sessions list API. */
export function publicView(s, currentSessionId = null) {
  return {
    sessionId: s.sessionId,
    device: s.device,
    browser: s.browser,
    os: s.os,
    ip: s.ip,
    provider: s.provider,
    createdAt: s.createdAt,
    lastActive: s.lastActive,
    expiresAt: s.expiresAt,
    current: s.sessionId === currentSessionId,
  };
}

export default {
  createSession, findById, isActive, listForUser, touch, rotateJti, revoke, revokeAllForUser, publicView, parseUserAgent,
};
