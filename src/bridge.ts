/**
 * The host's surface bridge, as seen from inside the comparison document.
 * The document runs in a sandboxed frame with an opaque origin: it holds no
 * host binding and can reach the host only through these messages. Each one
 * carries exactly the fields it needs, and the host answers every save and
 * copy with a result the document shows on its own status line.
 *
 * D-1040: this page writes text. The comparison item is read through the
 * `companion.read` service: after the host delivers the invoked item, the page
 * asks for the one neighbour it compares against, and the host chooses it. A
 * host that already pushed a companion with the item still works (older v3
 * drafts did); the page never learns where the neighbour came from.
 *
 * D-1042/D-1043: the host also sends the application's resolved colour scheme
 * and the design tokens that scheme resolved to; the document paints by them
 * instead of by the system's appearance or a palette of its own.
 *
 * D-1252: the page's working state crosses a detach through the host. A detach
 * asks this document for it through one message, answered with the standard
 * result; a window opened with a draft delivers it right after the menu
 * notice. The bridge carries the value; the document decides what it means.
 */

export type SurfaceTextItem = { kind: "text"; title: string; text: string };

export interface BridgeResult {
  ok: boolean;
  id?: number;
  message?: string;
}

/** A result carries the request it answers; only the bridge reads that field. */
interface ResultMessage extends BridgeResult {
  requestId: number;
  /** The companion item, when the host answers a `companion` request. */
  item?: unknown;
}

/** One delivery: the invoked item and, when declared, its comparison item. */
export interface SurfaceDelivery {
  item: SurfaceTextItem;
  companion: SurfaceTextItem | null;
}

export interface SurfaceBridge {
  readonly delivery: SurfaceDelivery | null;
  /** Registers the one receiver for the delivery; it fires at most once. */
  onItem(listener: (delivery: SurfaceDelivery) => void): void;
  /**
   * True once the host mounted this page as a settings menu page (D-1234):
   * it has no item, so the reader supplies both texts, and only the copy
   * request is answered — save and the companion are not in that channel.
   */
  readonly menu: boolean;
  /** Registers the one receiver for the menu notice; at most once. */
  onMenu(listener: () => void): void;
  /**
   * Registers where this page's working state comes from (D-1252): a detach
   * asks for it through one draft message, and the page answers with the
   * channel's standard result carrying the value. The bridge carries the
   * value; what it means is the page's business.
   */
  setDraftProvider(provider: (() => unknown) | null): void;
  /**
   * Registers the one receiver for the draft a detach carried into this
   * window (D-1252). The host delivers it once, right after the menu notice,
   * and a late receiver still learns what was carried.
   */
  onDraft(listener: (draft: unknown) => void): void;
  save(text: string, title: string): Promise<BridgeResult>;
  copy(text: string): Promise<BridgeResult>;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The host's first message to a menu page, before the theme (D-1234). */
function isMenuMode(data: unknown): boolean {
  return isRecord(data) && data.v === 1 && data.type === "menu";
}

/**
 * The host asks a mounted page for its working state before a detach opens the
 * menu's window (D-1252). The page answers with the channel's standard result,
 * so the ask and every other request use one reply shape.
 */
function isDraftAsk(data: unknown): data is { v: 1; type: "draft"; requestId: number } {
  return isRecord(data) && data.v === 1 && data.type === "draft" &&
    typeof data.requestId === "number";
}

/**
 * The host hands a window's page the draft a detach carried in, right after
 * the menu notice (D-1252): the page knows it is a menu page before it
 * applies the state that is being handed to it.
 */
function isDraftDelivery(data: unknown): data is {
  v: 1; type: "draft"; value: unknown;
} {
  return isRecord(data) && data.v === 1 && data.type === "draft" && "value" in data;
}

/** The application's resolved colour scheme (D-1042). */
type SurfaceScheme = "light" | "dark";

/** Resolved host tokens; keys are the host's CSS names without `--` (D-1043). */
type SurfaceTokens = Record<string, string>;

interface ParsedTheme {
  scheme: SurfaceScheme;
  tokens: SurfaceTokens;
}

/** The only shape a token name may take once it is prefixed with `--mp-`. */
const TOKEN_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * parseTheme reads the scheme the host resolved from the application's
 * appearance. The frame's own prefers-color-scheme follows the system, so it
 * cannot answer this question on its own.
 */
function parseTheme(data: unknown): ParsedTheme | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "theme") return null;
  if (data.scheme !== "light" && data.scheme !== "dark") return null;
  const tokens: SurfaceTokens = {};
  // Unknown keys are ignored: the document has no registry of the host's
  // theme, and a value it has no rule for sets a variable nothing reads. Only
  // non-empty strings reach CSS.
  if (isRecord(data.tokens)) {
    for (const [name, value] of Object.entries(data.tokens)) {
      if (typeof value === "string" && value !== "" && TOKEN_NAME.test(name)) {
        tokens[name] = value;
      }
    }
  }
  return { scheme: data.scheme, tokens };
}

/**
 * applyTheme writes the host's resolved values onto this document's root as
 * `--mp-<name>` (D-1043). The stylesheet prefers those variables and keeps
 * its own palette as the fallback, so an older host that sends no tokens still
 * paints, and a new host repaints whenever the pair changes.
 */
function applyTheme(theme: ParsedTheme): void {
  const root = document.documentElement;
  root.dataset.scheme = theme.scheme;
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--mp-${name}`, value);
  }
}

function parseTextItem(value: unknown): SurfaceTextItem | null {
  if (!isRecord(value) || value.kind !== "text" ||
    typeof value.title !== "string" || typeof value.text !== "string") {
    return null;
  }
  return { kind: "text", title: value.title, text: value.text };
}

function parseItem(data: unknown): SurfaceTextItem | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "item") return null;
  return parseTextItem(data.item);
}

/**
 * connectSurface wires the bridge and tells the host the document is ready.
 * The host sends the delivery only after that; a document that renders first
 * and asks later would race a host that already delivered.
 */
export function connectSurface(): SurfaceBridge {
  let delivery: SurfaceDelivery | null = null;
  const listeners: ((delivery: SurfaceDelivery) => void)[] = [];
  let menu = false;
  const menuListeners: (() => void)[] = [];
  const pending = new Map<number, (result: ResultMessage) => void>();
  let nextRequest = 1;
  let delivering = false;
  // Draft carries (D-1252): where the page's working state comes from, the
  // receivers for a draft a detach carried in, and the last one for a receiver
  // that registered after the delivery landed.
  let draftProvider: (() => unknown) | null = null;
  const draftListeners: ((draft: unknown) => void)[] = [];
  let carriedDraft: unknown = null;
  let draftDelivered = false;

  function post(message: unknown): void {
    parent.postMessage(message, "*");
  }

  function request(message: Record<string, unknown>): Promise<ResultMessage> {
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      post({ ...message, v: 1, requestId });
    });
  }

  /**
   * Reads the comparison item. A host that already pushed one with the item
   * keeps working; otherwise the page asks for it through `companion.read`.
   * A malformed pushed companion makes the pair unusable rather than half a
   * comparison, exactly as v2 refused it.
   *
   * A menu window may carry one entry and nothing to compare it with (D-1255):
   * that channel has no `companion` request at all, so asking would wait for an
   * answer the host never sends. The delivery there keeps the companion null
   * and the reader supplies the other side, as the menu page already expects.
   */
  async function deliver(item: SurfaceTextItem, message: unknown): Promise<void> {
    if (delivering) return;
    delivering = true;
    const pushed = isRecord(message) ? message.companion : undefined;
    let companion: SurfaceTextItem | null;
    if (pushed !== undefined) {
      companion = parseTextItem(pushed);
      if (!companion) return;
    } else if (menu) {
      companion = null;
    } else {
      const result = await request({ type: "companion" });
      companion = result.ok ? parseTextItem(result.item) : null;
    }
    delivery = { item, companion };
    for (const listener of listeners.splice(0)) listener(delivery);
  }

  // The system appearance only covers the moment before the host speaks: the
  // host sends the scheme the application actually resolved (D-1042).
  document.documentElement.dataset.scheme =
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    const item = parseItem(data);
    if (item) {
      void deliver(item, data);
      return;
    }
    if (isMenuMode(data)) {
      menu = true;
      for (const listener of menuListeners.splice(0)) listener();
      return;
    }
    if (isDraftAsk(data)) {
      // A detach asked for this page's working state (D-1252). The channel's
      // standard result is the answer, so the ask needs no new reply shape; a
      // page with no provider answers with nothing carried.
      post({
        v: 1, type: "result", requestId: data.requestId, ok: true,
        value: draftProvider ? draftProvider() : null,
      });
      return;
    }
    if (isDraftDelivery(data)) {
      carriedDraft = data.value;
      draftDelivered = true;
      for (const listener of draftListeners.splice(0)) listener(data.value);
      return;
    }
    const theme = parseTheme(data);
    if (theme) {
      applyTheme(theme);
      return;
    }
    if (!isRecord(data) || data.v !== 1 || data.type !== "result") return;
    const result = data as unknown as ResultMessage;
    const resolve = pending.get(result.requestId);
    if (!resolve) return;
    pending.delete(result.requestId);
    resolve({ ...result, ok: Boolean(result.ok) });
  });

  post({ v: 1, type: "ready" });

  return {
    get delivery() {
      return delivery;
    },
    onItem(listener) {
      if (delivery) {
        listener(delivery);
        return;
      }
      listeners.push(listener);
    },
    get menu() {
      return menu;
    },
    onMenu(listener) {
      if (menu) {
        listener();
        return;
      }
      menuListeners.push(listener);
    },
    setDraftProvider(provider) {
      draftProvider = provider;
    },
    onDraft(listener) {
      // A page that registers after the delivery landed still learns what was
      // carried, the same way a late item or menu listener does.
      if (draftDelivered) {
        listener(carriedDraft);
        return;
      }
      draftListeners.push(listener);
    },
    async save(text, title) {
      const result = await request({ type: "save", text, title });
      return { ok: result.ok, id: result.id, message: result.message };
    },
    async copy(text) {
      const result = await request({ type: "copy", text });
      return { ok: result.ok, id: result.id, message: result.message };
    },
    close() {
      post({ v: 1, type: "close" });
    },
  };
}
