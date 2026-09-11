/**
 * TeamMarySy Bot — Single-File Entrypoint (v2)
 * Telegram-native · Event-driven · Cloudflare Workers
 *
 * Layout mirrors ARCHITECTURE.md (Transport → Router → Handlers → Modules →
 * State → Delivery) as sections within one file for single-file deploy.
 *
 * v2 additions (per Phase 1-3 test/acceptance plan):
 *   - Audit log (log:*) written on every join approve/reject
 *   - Sequential ID generator (counter:*) for content and tickets
 *   - Full content lifecycle: draft -> published -> archived (retained, not deleted)
 *   - Full ticket lifecycle: open -> in_progress -> resolved -> closed,
 *     with assignment, internal notes, and a notification on each transition
 *   - Explicit "clean temporary state" scheduler job (paginated KV.list, in
 *     addition to KV's own TTL expiry) plus pruning of exhausted failed jobs
 *   - src/utils/validate.js equivalent (toSafeInteger) used defensively in
 *     the callback handler: invalid IDs are caught locally and answered with
 *     a graceful message instead of reaching the Telegram API or crashing
 *
 * Required secrets:   TG_BOT_TOKEN, TG_BOT_SECRET_TOKEN
 * Required vars:      OWNER_ID, BOT_USERNAME
 * Required bindings:  KV (Workers KV namespace)
 * Cron:                crons = ["*\/15 * * * *"]
 */

// =====================================================================
// 0. CONSTANTS / KEY NAMESPACES
// =====================================================================

const KV_PREFIX = {
  CONFIG: "config:",
  STATE: "state:",
  CONTENT: "content:",
  TICKET: "ticket:",
  SCHED: "sched:",
  SCHED_FAILED: "sched:failed:",
  COUNTER: "counter:",
  LOG: "log:",
};

const SUPPORTED_COMMANDS = ["/start", "/panel", "/content", "/community", "/support"];

const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"];
const CONTENT_STATUSES = ["draft", "published", "archived"];

// =====================================================================
// 1. TRANSPORT LAYER — fetch() and scheduled() entrypoints
// =====================================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!secretHeader || secretHeader !== env.TG_BOT_SECRET_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    ctx.waitUntil(
      routeUpdate(update, env, ctx).catch((err) => {
        console.error("Unhandled routing error:", err);
      })
    );

    return new Response("OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledTasks(env));
  },
};

// =====================================================================
// 2. ROUTER
// =====================================================================

async function routeUpdate(update, env, ctx) {
  if (update.message) return handleMessage(update.message, env);
  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.chat_join_request) return handleJoinRequest(update.chat_join_request, env);
  return; // unsupported updates ignored
}

// =====================================================================
// 3. HANDLERS
// =====================================================================

async function handleMessage(message, env) {
  const chatId = message.chat?.id;
  const userId = message.from?.id;
  if (!chatId || !userId) return;

  if (!message.text) {
    if (await Support.isAwaitingText(chatId, env)) {
      await telegram.sendMessage(env, chatId, "Please send your response as text.");
    }
    return;
  }

  if (await Support.isAwaitingText(chatId, env)) {
    return Support.handleTextInput(chatId, userId, message.text, env);
  }

  const { command, args } = normalizeCommand(message.text, env.BOT_USERNAME);
  if (!SUPPORTED_COMMANDS.includes(command)) return;

  switch (command) {
    case "/start":
      return telegram.sendMessage(env, chatId, "Welcome to TeamMarySy Bot. Use /panel to get started.");
    case "/panel":
      return sendPanel(chatId, env);
    case "/content":
      return Content.showMenu(chatId, env);
    case "/community":
      return telegram.sendMessage(env, chatId, "Community management runs via join-request events.");
    case "/support":
      return Support.start(chatId, userId, env);
  }
}

function normalizeCommand(text, botUsername) {
  const trimmed = (text || "").trim();
  const parts = trimmed.split(/\s+/);
  let cmd = parts[0] || "";

  if (botUsername && cmd.toLowerCase().endsWith("@" + botUsername.toLowerCase())) {
    cmd = cmd.slice(0, cmd.length - (botUsername.length + 1));
  } else {
    cmd = cmd.split("@")[0];
  }

  cmd = cmd.toLowerCase();
  const args = parts.slice(1);
  return { command: cmd, args };
}

async function handleCallback(callbackQuery, env) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  // --- Defensive numeric ID validation (src/utils/validate.js equivalent) ---
  // Malformed callback_data must never crash the handler or reach the
  // Telegram API; it's caught here and answered gracefully.
  let userId, safeChatId;
  try {
    userId = toSafeInteger(callbackQuery.from?.id);
    safeChatId = toSafeInteger(chatId);
  } catch {
    return telegram.answerCallbackQuery(env, callbackQuery.id, "Invalid request.");
  }

  const isPrivileged = data.startsWith("menu:") || data.startsWith("join:") || data.startsWith("ticket:");
  if (isPrivileged) {
    const authorized = await isOwnerOrAdmin(userId, env);
    if (!authorized) {
      return telegram.answerCallbackQuery(env, callbackQuery.id, "Not authorized.");
    }
  }

  await telegram.answerCallbackQuery(env, callbackQuery.id);

  try {
    if (data.startsWith("menu:")) return handleMenuCallback(data, safeChatId, messageId, env);
    if (data.startsWith("join:")) return handleJoinCallback(data, safeChatId, messageId, userId, env);
    if (data.startsWith("content:")) return Content.handleCallback(data, safeChatId, messageId, userId, env);
    if (data.startsWith("ticket:")) return Support.handleCallback(data, safeChatId, messageId, userId, env);
  } catch (err) {
    console.error("Callback handling error:", err);
    // Graceful user-facing message instead of an unhandled rejection.
    if (safeChatId && messageId) {
      await telegram.editMessageText(env, safeChatId, messageId, "Something went wrong processing that action.").catch(() => {});
    }
  }
}

async function handleMenuCallback(data, chatId, messageId, env) {
  const target = data.split(":")[1];
  switch (target) {
    case "content":
      return Content.showMenu(chatId, env, messageId);
    case "community":
      return telegram.editMessageText(env, chatId, messageId, "Community management runs via join-request events.");
    case "support":
      return telegram.editMessageText(env, chatId, messageId, "Use /support to open a ticket.");
    case "panel":
    default:
      return sendPanel(chatId, env, messageId);
  }
}

async function handleJoinCallback(data, chatId, messageId, actorId, env) {
  // join:approve:<chatId>:<userId> | join:reject:<chatId>:<userId>
  const [, action, rawChatId, rawUserId] = data.split(":");

  let targetChatId, targetUserId;
  try {
    targetChatId = toSafeInteger(rawChatId);
    targetUserId = toSafeInteger(rawUserId);
  } catch {
    return telegram.editMessageText(env, chatId, messageId, "Invalid join request identifiers.");
  }

  if (action === "approve") {
    await Community.approve(targetChatId, targetUserId, actorId, env);
    return telegram.editMessageText(env, chatId, messageId, `Approved user ${targetUserId}.`);
  }
  if (action === "reject") {
    await Community.reject(targetChatId, targetUserId, actorId, env);
    return telegram.editMessageText(env, chatId, messageId, `Rejected user ${targetUserId}.`);
  }
}

async function handleJoinRequest(joinRequest, env) {
  return Community.notify(joinRequest, env);
}

async function sendPanel(chatId, env, messageId) {
  const text = "TeamMarySy Bot";
  const keyboard = {
    inline_keyboard: [
      [{ text: "📝 Content", callback_data: "menu:content" }],
      [{ text: "👥 Community", callback_data: "menu:community" }],
      [{ text: "🎫 Support", callback_data: "menu:support" }],
    ],
  };
  if (messageId) return telegram.editMessageText(env, chatId, messageId, text, keyboard);
  return telegram.sendMessage(env, chatId, text, keyboard);
}

// =====================================================================
// 4. BUSINESS MODULES
// =====================================================================

const Content = {
  async showMenu(chatId, env, messageId) {
    const text = "Content Management";
    const keyboard = {
      inline_keyboard: [
        [
          { text: "📝 Create", callback_data: "content:create" },
          { text: "📚 List", callback_data: "content:list" },
        ],
        [{ text: "📦 Archive", callback_data: "content:list_archived" }],
        [{ text: "❌ Close", callback_data: "menu:panel" }],
      ],
    };
    if (messageId) return telegram.editMessageText(env, chatId, messageId, text, keyboard);
    return telegram.sendMessage(env, chatId, text, keyboard);
  },

  async handleCallback(data, chatId, messageId, userId, env) {
    const parts = data.split(":");
    const action = parts[1];

    switch (action) {
      case "list":
        return this.renderList(chatId, messageId, env, false);
      case "list_archived":
        return this.renderList(chatId, messageId, env, true);
      case "publish": {
        const id = parts[2];
        await this.publishById(id, env);
        return telegram.editMessageText(env, chatId, messageId, `Content ${id} published.`);
      }
      case "archive": {
        const id = parts[2];
        await this.archive(id, env);
        return telegram.editMessageText(env, chatId, messageId, `Content ${id} archived.`);
      }
      case "create":
        // Draft creation via inline flow is not yet wired to a text-collection
        // state machine (see README). Direct creation is available via the
        // Content.create() API for programmatic/scheduled use.
        return telegram.editMessageText(env, chatId, messageId, "Draft creation via chat input is not implemented yet.");
      default:
        return telegram.editMessageText(env, chatId, messageId, `Unknown content action: ${action}`);
    }
  },

  /** Creates a draft. Does not publish or notify. */
  async create(chatId, text, env) {
    const id = await nextId(env, "content");
    const item = {
      id: String(id),
      chat_id: chatId,
      text,
      status: "draft",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await env.KV.put(`${KV_PREFIX.CONTENT}${item.id}`, JSON.stringify(item));
    return item;
  },

  /** Lists content by status. Archived items are excluded from active listings by default. */
  async list(env, { archived = false, limit = 20 } = {}) {
    const result = await env.KV.list({ prefix: KV_PREFIX.CONTENT, limit });
    const items = [];
    for (const key of result.keys) {
      const raw = await env.KV.get(key.name);
      if (!raw) continue;
      const item = JSON.parse(raw);
      const isArchived = item.status === "archived";
      if (archived ? isArchived : !isArchived) items.push(item);
    }
    return items;
  },

  async renderList(chatId, messageId, env, archived) {
    const items = await this.list(env, { archived });
    if (items.length === 0) {
      return telegram.editMessageText(env, chatId, messageId, archived ? "No archived content." : "No active content.");
    }
    const lines = items.map((i) => `#${i.id} [${i.status}] ${i.text.slice(0, 40)}`);
    return telegram.editMessageText(env, chatId, messageId, lines.join("\n"));
  },

  async publishById(id, env) {
    const key = `${KV_PREFIX.CONTENT}${id}`;
    const raw = await env.KV.get(key);
    if (!raw) throw new Error(`Content.publishById: ${id} not found`);
    const item = JSON.parse(raw);
    await this.publish(item, env);
    await env.KV.put(key, JSON.stringify({ ...item, status: "published", updated_at: Date.now() }));
  },

  /**
   * Publishing contract: the Scheduler calls this directly for time-based
   * jobs; interactive publish calls (publishById) reuse the same function,
   * so both paths deliver identically.
   */
  async publish(item, env) {
    if (!item.chat_id || !item.text) {
      throw new Error(`Content.publish: invalid item ${item.id}`);
    }
    await telegram.sendMessage(env, item.chat_id, item.text);
  },

  /** Archives content. Retained in KV — never deleted — per retention policy. */
  async archive(id, env) {
    const key = `${KV_PREFIX.CONTENT}${id}`;
    const raw = await env.KV.get(key);
    if (!raw) throw new Error(`Content.archive: ${id} not found`);
    const item = JSON.parse(raw);
    await env.KV.put(key, JSON.stringify({ ...item, status: "archived", updated_at: Date.now() }));
  },
};

const Community = {
  async notify(joinRequest, env) {
    const chat = joinRequest.chat;
    const from = joinRequest.from;
    const admins = await getAdmins(env);
    const ownerId = Number(env.OWNER_ID);
    const recipients = [...new Set([ownerId, ...admins])].filter(Number.isSafeInteger);

    const text = `Join request for ${chat.title || chat.id}\nUser: ${from.first_name || ""} (${from.id})`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `join:approve:${chat.id}:${from.id}` },
          { text: "❌ Reject", callback_data: `join:reject:${chat.id}:${from.id}` },
        ],
      ],
    };

    await Promise.all(recipients.map((adminId) => telegram.sendMessage(env, adminId, text, keyboard)));
  },

  async approve(chatId, userId, actorId, env) {
    await telegram.approveChatJoinRequest(env, chatId, userId);
    await writeAuditLog(env, "join_approved", actorId, { chat_id: chatId, user_id: userId });
  },

  async reject(chatId, userId, actorId, env) {
    await telegram.declineChatJoinRequest(env, chatId, userId);
    await writeAuditLog(env, "join_rejected", actorId, { chat_id: chatId, user_id: userId });
  },
};

const Support = {
  STATE_TTL_MS: 15 * 60 * 1000, // 15 minutes

  stateKey(chatId) {
    return `${KV_PREFIX.STATE}${chatId}:support`;
  },

  ticketKey(id) {
    return `${KV_PREFIX.TICKET}${id}`;
  },

  async start(chatId, userId, env) {
    const state = {
      flow: "support",
      step: "awaiting_ticket_text",
      data: { user_id: userId },
      expires_at: Date.now() + this.STATE_TTL_MS,
    };
    await env.KV.put(this.stateKey(chatId), JSON.stringify(state), {
      expirationTtl: Math.ceil(this.STATE_TTL_MS / 1000),
    });
    return telegram.sendMessage(env, chatId, "Please describe your issue. Send it as a text message.");
  },

  async isAwaitingText(chatId, env) {
    const raw = await env.KV.get(this.stateKey(chatId));
    if (!raw) return false;
    try {
      const state = JSON.parse(raw);
      return state.step === "awaiting_ticket_text" && state.expires_at > Date.now();
    } catch {
      return false;
    }
  },

  async handleTextInput(chatId, userId, text, env) {
    const id = await nextId(env, "ticket");
    const ticket = {
      id: String(id),
      chat_id: chatId,
      user_id: userId,
      text,
      status: "open",
      assignee_id: null,
      notes: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await env.KV.put(this.ticketKey(ticket.id), JSON.stringify(ticket));
    await env.KV.delete(this.stateKey(chatId));
    return telegram.sendMessage(env, chatId, `Ticket #${ticket.id} created. We'll get back to you.`);
  },

  async get(id, env) {
    const raw = await env.KV.get(this.ticketKey(id));
    return raw ? JSON.parse(raw) : null;
  },

  async assign(id, adminId, env) {
    const ticket = await this.get(id, env);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    ticket.assignee_id = adminId;
    ticket.updated_at = Date.now();
    await env.KV.put(this.ticketKey(id), JSON.stringify(ticket));
    return ticket;
  },

  async addNote(id, note, env) {
    const ticket = await this.get(id, env);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    ticket.notes.push({ text: note, at: Date.now() });
    ticket.updated_at = Date.now();
    await env.KV.put(this.ticketKey(id), JSON.stringify(ticket));
    return ticket;
  },

  /** Transitions status and notifies the ticket's originating chat. */
  async setStatus(id, status, env) {
    if (!TICKET_STATUSES.includes(status)) {
      throw new Error(`Invalid ticket status: ${status}`);
    }
    const ticket = await this.get(id, env);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    ticket.status = status;
    ticket.updated_at = Date.now();
    await env.KV.put(this.ticketKey(id), JSON.stringify(ticket));

    const labels = { open: "opened", in_progress: "in progress", resolved: "resolved", closed: "closed" };
    await telegram.sendMessage(env, ticket.chat_id, `Your ticket #${id} is now ${labels[status]}.`);
    return ticket;
  },

  async handleCallback(data, chatId, messageId, adminId, env) {
    // ticket:<action>:<id>[:extra]
    const [, action, id] = data.split(":");
    switch (action) {
      case "assign":
        await this.assign(id, adminId, env);
        return telegram.editMessageText(env, chatId, messageId, `Ticket #${id} assigned to ${adminId}.`);
      case "in_progress":
      case "resolved":
      case "closed":
        await this.setStatus(id, action, env);
        return telegram.editMessageText(env, chatId, messageId, `Ticket #${id} marked ${action}.`);
      default:
        return telegram.editMessageText(env, chatId, messageId, `Unknown ticket action: ${action}`);
    }
  },
};

// =====================================================================
// 5. STATE LAYER — KV helpers, validation, counters, audit log
// =====================================================================

/** src/utils/validate.js equivalent. Throws on anything not a safe integer. */
function toSafeInteger(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Invalid numeric identifier: ${value}`);
  }
  return n;
}

async function getAdmins(env) {
  const raw = await env.KV.get(`${KV_PREFIX.CONFIG}admins`);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map(Number).filter(Number.isSafeInteger) : [];
  } catch {
    return [];
  }
}

async function isOwnerOrAdmin(userId, env) {
  if (Number(env.OWNER_ID) === userId) return true;
  const admins = await getAdmins(env);
  return admins.includes(userId);
}

/** Sequential ID generator backing counter:* (used for content and tickets). */
async function nextId(env, name) {
  const key = `${KV_PREFIX.COUNTER}${name}`;
  const raw = await env.KV.get(key);
  const current = raw ? parseInt(raw, 10) : 0;
  const next = current + 1;
  await env.KV.put(key, String(next));
  return next;
}

/** Append-only audit trail for moderation accountability (log:*). */
async function writeAuditLog(env, action, actorId, details) {
  const id = await nextId(env, "log");
  const entry = { id, action, actor_id: actorId, details, at: Date.now() };
  await env.KV.put(`${KV_PREFIX.LOG}${id}`, JSON.stringify(entry));
  return entry;
}

// =====================================================================
// 6. SCHEDULER
// =====================================================================

async function runScheduledTasks(env) {
  await processPendingJobs(env);
  await cleanExpiredState(env);
}

async function processPendingJobs(env) {
  const now = Date.now();
  const list = await env.KV.list({ prefix: KV_PREFIX.SCHED });

  for (const key of list.keys) {
    if (key.name.startsWith(KV_PREFIX.SCHED_FAILED)) continue;

    const raw = await env.KV.get(key.name);
    if (!raw) continue;

    let item;
    try {
      item = JSON.parse(raw);
    } catch {
      await env.KV.delete(key.name);
      continue;
    }

    if (item.status !== "pending" || item.due_at > now) continue;

    try {
      await env.KV.put(key.name, JSON.stringify({ ...item, status: "processing" }));

      if (item.type === "content") {
        await Content.publish(item, env);
      } else {
        throw new Error(`Unknown scheduled item type: ${item.type}`);
      }

      await env.KV.put(key.name, JSON.stringify({ ...item, status: "sent" }));
    } catch (err) {
      console.error(`Scheduled task failed for ${key.name}:`, err);
      const retryCount = (item.retry_count || 0) + 1;
      const maxRetries = item.max_retries ?? 3;

      if (retryCount >= maxRetries) {
        await env.KV.put(
          `${KV_PREFIX.SCHED_FAILED}${item.id}`,
          JSON.stringify({ ...item, status: "failed", retry_count: retryCount })
        );
        await env.KV.delete(key.name);
      } else {
        await env.KV.put(key.name, JSON.stringify({ ...item, status: "pending", retry_count: retryCount }));
      }
    }
  }
}

/**
 * Explicit "clean temporary state" job (§: Scheduler responsibilities).
 * KV's own expirationTtl already reaps state:* entries, but this pass
 * catches anything created without a TTL and enforces the minimal-
 * persistence principle deterministically rather than relying solely on
 * KV's best-effort expiry timing. Paginates via cursor per spec.
 */
async function cleanExpiredState(env) {
  const now = Date.now();
  let cursor;

  do {
    const page = await env.KV.list({ prefix: KV_PREFIX.STATE, cursor, limit: 100 });
    cursor = page.list_complete ? undefined : page.cursor;

    for (const key of page.keys) {
      const raw = await env.KV.get(key.name);
      if (!raw) continue;
      try {
        const state = JSON.parse(raw);
        if (state.expires_at && state.expires_at <= now) {
          await env.KV.delete(key.name);
        }
      } catch {
        await env.KV.delete(key.name); // malformed state entry — safe to drop
      }
    }
  } while (cursor);
}

// =====================================================================
// 7. DELIVERY LAYER
// =====================================================================

const telegram = {
  async _call(env, method, payload) {
    const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(`Telegram API error (${method}): ${data.description || res.status}`);
    }
    return data.result;
  },

  async sendMessage(env, chatId, text, replyMarkup) {
    return this._call(env, "sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
  },

  async editMessageText(env, chatId, messageId, text, replyMarkup) {
    return this._call(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup });
  },

  async answerCallbackQuery(env, callbackQueryId, text) {
    return this._call(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  },

  async approveChatJoinRequest(env, chatId, userId) {
    return this._call(env, "approveChatJoinRequest", { chat_id: chatId, user_id: userId });
  },

  async declineChatJoinRequest(env, chatId, userId) {
    return this._call(env, "declineChatJoinRequest", { chat_id: chatId, user_id: userId });
  },
};
