/**
 * 高亮对比工作台：宿主交付本次调用的条目，以及清单声明的相邻一条文本
 * （D-1040）。两份文本的逐行对齐与词级标记由本包自带的 diff 引擎完成；
 * 文档不联网、不读取其它条目，也不调用宿主的扩展。
 *
 * 单击任一侧的面板即进入该侧编辑，光标落在点击处：该侧在高亮列原来的位置
 * 换成同字号、同行距、同行号槽的透明 textarea，另一侧继续显示高亮行并随
 * 输入重算。页面不因此换底色，也不改版式，始终只有一条滚动条。点标题、行号
 * 或最后一行以下的空白同样算作这一侧的编辑，只把光标放到该侧末尾；编辑中
 * 单击另一侧即切换编辑对象。Esc 先退出编辑，再按一次才关闭文档。页面自己画卡片的
 * 外框（manifest 的 surface.chrome: "page"），所以关闭按钮在标签条右端，
 * 经桥的 close 请求交回宿主。
 */

import { connectSurface, type SurfaceDelivery } from "./bridge";
import { diffSummary, diffText, type DiffRow } from "./diff";
import { detectLanguage, languageLabel } from "./languages";

type Side = "before" | "after";

const bridge = connectSurface();

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`工作台文档缺少 ${selector}`);
  return element;
}

const currentTitle = one<HTMLElement>("#current-title");
const companionTitle = one<HTMLElement>("#companion-title");
const languageLabelElement = one<HTMLElement>("#diff-language");
const stats = one<HTMLElement>("#diff-stats");
const rows = one<HTMLElement>("#diff-rows");
const scroller = one<HTMLElement>("#diff-scroller");
const saveButton = one<HTMLButtonElement>("[data-action=save]");
const closeButton = one<HTMLButtonElement>("#doc-close");
const copyButton = one<HTMLButtonElement>("[data-action=copy]");
const status = one<HTMLElement>("#diff-status");
const emptyState = one<HTMLElement>("#diff-empty");

/**
 * The two texts the document holds. `before` is the comparison baseline; only
 * `after` is saved or copied, so editing the left side changes the comparison
 * without changing what the right side would write into history.
 */
let beforeText = "";
let afterText = "";
let currentName = "";
let editing: Side | null = null;
let busy = false;

type DiffResult = ReturnType<typeof diffText>;

/**
 * The last comparison, kept so entering an editor does not diff the same two
 * texts a second time; every keystroke clears it until the next repaint.
 */
let cachedResult: DiffResult | null = null;

/** Typing repaints the read-only column at most this often, in milliseconds. */
const REPAINT_INTERVAL = 150;
/** A repaint that itself takes long backs off up to this interval. */
const REPAINT_INTERVAL_MAX = 600;
let repaintInterval = REPAINT_INTERVAL;
let repaintTimer = 0;
let lastRepaintAt = 0;

function setStatus(text: string, failed = false): void {
  status.textContent = text;
  status.dataset.tone = failed ? "error" : "info";
  status.hidden = text === "";
}

function cell(className: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}

function appendSegments(target: HTMLElement, segments: DiffRow["before"]): void {
  for (const segment of segments) {
    if (segment.changed) {
      const mark = document.createElement("span");
      mark.className = "diff-mark";
      mark.textContent = segment.text;
      target.append(mark);
      continue;
    }
    target.append(segment.text);
  }
}

function sideCell(row: DiffRow, side: Side): HTMLElement {
  const line = cell(`line ${side}`);
  // The side is written by the producer, not guessed from the column: the
  // click handler reads it back to choose which text to edit.
  line.dataset.side = side;
  const number = side === "before" ? row.beforeLine : row.afterLine;
  const gutter = document.createElement("span");
  gutter.className = number === null ? "line-number empty" : "line-number";
  // The roles let the click handler find these two parts again without
  // depending on class names the stylesheet also owns.
  gutter.dataset.role = "number";
  if (number !== null) gutter.textContent = String(number);
  line.append(gutter);
  const text = cell("line-text");
  text.dataset.role = "text";
  appendSegments(text, side === "before" ? row.before : row.after);
  line.append(text);
  return line;
}

function rowElement(row: DiffRow): HTMLElement {
  const element = cell("diff-row");
  element.dataset.kind = row.kind;
  element.append(sideCell(row, "before"), sideCell(row, "after"));
  return element;
}

/** One highlighted column, without its counterpart (edit mode). */
function columnFragment(rowsIn: readonly DiffRow[], side: Side): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const row of rowsIn) {
    const element = cell("diff-row");
    element.dataset.kind = row.kind;
    element.append(sideCell(row, side));
    fragment.append(element);
  }
  return fragment;
}

/**
 * The same side, one row per line that side actually has — the counterpart's
 * insertions and deletions leave no line box here, so this lines up with the
 * text the editor holds. Used as the editor's background.
 */
function sideFragment(rowsIn: readonly DiffRow[], side: Side): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const row of rowsIn) {
    if ((side === "before" ? row.beforeLine : row.afterLine) === null) continue;
    const element = cell("diff-row");
    element.dataset.kind = row.kind;
    element.append(sideCell(row, side));
    fragment.append(element);
  }
  return fragment;
}

function summaryText(): string {
  return `文本 · ${languageLabel(detectLanguage(afterText))}`;
}

/**
 * The status line states the one thing that matters now: an empty current
 * text disables both actions, editing shows its own way out, and otherwise
 * the result's own limits are reported.
 */
function showStatus(result: DiffResult): void {
  if (afterText.trim() === "") {
    setStatus("当前文本为空，无法保存或复制");
    return;
  }
  if (editing !== null) {
    setStatus(
      editing === "before"
        ? "正在编辑对比基准 · ⌘↩ 保存为新条目 · Esc 退出"
        : "正在编辑当前文本 · ⌘↩ 保存为新条目 · Esc 退出",
    );
    return;
  }
  if (result.truncated) setStatus("文本过长，只比较了前面一部分");
  else if (result.coarse) setStatus("改动过多，按位置配对而不是逐词对齐");
  else setStatus("");
}

function updateActions(): void {
  const enabled = !busy && afterText.trim() !== "";
  saveButton.disabled = !enabled;
  copyButton.disabled = !enabled;
}

/**
 * The header's two halves must meet on the panes' own vertical line. The
 * panes sit inside the scroller, whose bar takes width away from them, so the
 * header gives up exactly that measured width. It is measured rather than
 * assumed because the engine decides whether a short document reserves the
 * bar at all.
 */
function syncPaneGutter(): void {
  const gutter = scroller.offsetWidth - scroller.clientWidth;
  document.documentElement.style.setProperty("--pane-gutter", `${gutter}px`);
}

/** The read-only comparison. */
function renderView(): void {
  editing = null;
  rows.classList.remove("editing");
  const result = diffText(beforeText, afterText);
  cachedResult = result;
  stats.textContent = diffSummary(result);
  const fragment = document.createDocumentFragment();
  for (const row of result.rows) fragment.append(rowElement(row));
  rows.replaceChildren(fragment);
  syncPaneGutter();
  showStatus(result);
  updateActions();
}

/**
 * Live re-diff for the column that is not being typed in. Diffing both texts
 * on every keystroke is what made typing feel heavy on long texts, so an
 * input only schedules a repaint and the repaint itself is rate-limited.
 */
function repaintEdit(): void {
  const side = editing;
  if (side === null) return;
  const result = diffText(beforeText, afterText);
  cachedResult = result;
  stats.textContent = diffSummary(result);
  const column = rows.querySelector<HTMLElement>('[data-column="other"]');
  if (column) {
    column.replaceChildren(
      columnFragment(result.rows, side === "before" ? "after" : "before"),
    );
  }
  const shade = rows.querySelector<HTMLElement>(".edit-shade");
  if (shade) shade.replaceChildren(sideFragment(result.rows, side));
  syncPaneGutter();
  showStatus(result);
  updateActions();
}

function scheduleRepaint(): void {
  if (repaintTimer !== 0) return;
  const wait = Math.max(0, repaintInterval - (performance.now() - lastRepaintAt));
  repaintTimer = window.setTimeout(() => {
    repaintTimer = 0;
    if (editing === null) return;
    const started = performance.now();
    repaintEdit();
    lastRepaintAt = performance.now();
    // A repaint that already cost more than a keystroke's worth backs off, so
    // long texts trade freshness of the comparison for a responsive editor.
    const spent = lastRepaintAt - started;
    repaintInterval = spent > 60
      ? Math.min(REPAINT_INTERVAL_MAX, Math.max(REPAINT_INTERVAL, spent * 2))
      : REPAINT_INTERVAL;
  }, wait);
}

/**
 * The editor grows with its text so nothing inside it scrolls of its own:
 * the page keeps the single scrollbar it had before the click.
 */
function fitEditor(editor: HTMLTextAreaElement): void {
  editor.style.height = "auto";
  editor.style.height = `${editor.scrollHeight}px`;
}

/**
 * One side in edit mode: a plain, transparent textarea held across
 * keystrokes. Rebuilding it on every input would move the caret and drop the
 * undo stack, so only the other column is replaced while the user types. The
 * editor takes the place the highlighted column had — same padding, gutter,
 * numbers and line rhythm — so the page does not move or change colour when
 * it is clicked.
 */
function renderEdit(caret?: number): void {
  const side = editing;
  if (side === null) return;
  // Entry reuses the comparison just drawn; only a keystroke invalidates it.
  const result = cachedResult ?? diffText(beforeText, afterText);
  cachedResult = result;
  repaintInterval = REPAINT_INTERVAL;
  stats.textContent = diffSummary(result);

  const editorPane = cell("edit-side");
  editorPane.dataset.side = side;
  // The comparison's own colour stays under the editor: the shades are the
  // rows this side had a moment ago, with their glyphs left to the textarea.
  const shade = cell("edit-shade");
  shade.setAttribute("aria-hidden", "true");
  shade.append(sideFragment(result.rows, side));
  // Only the number column's width: the digits are the shade's rows, so they
  // share the text's wrapping.
  const gutter = cell("edit-gutter");
  gutter.dataset.role = "gutter";
  const textarea = document.createElement("textarea");
  textarea.className = "edit-input";
  textarea.dataset.role = "editor";
  textarea.spellcheck = false;
  textarea.value = side === "before" ? beforeText : afterText;
  textarea.setAttribute(
    "aria-label",
    side === "before" ? "编辑对比基准文本" : "编辑当前文本",
  );
  textarea.addEventListener("input", () => {
    if (side === "before") beforeText = textarea.value;
    else afterText = textarea.value;
    cachedResult = null;
    languageLabelElement.textContent = summaryText();
    if (afterText.trim() === "") setStatus("当前文本为空，无法保存或复制");
    updateActions();
    fitEditor(textarea);
    scheduleRepaint();
  });
  editorPane.append(shade, gutter, textarea);

  const otherSide: Side = side === "before" ? "after" : "before";
  const other = cell("diff-column");
  other.dataset.side = otherSide;
  other.dataset.column = "other";
  if (rows.classList.contains("editing")) {
    // Switching sides: the column kept from the first click is missing the
    // side the editor held, so it is drawn again from the comparison on screen.
    other.append(columnFragment(result.rows, otherSide));
  } else {
    // Entering edit: the read-only column keeps the exact rows it was painted
    // with. Moving them changes no colour, no mark and no line box, so the
    // click hands one column to the editor and leaves the other as it was.
    for (const rowNode of [...rows.children]) {
      rowNode.querySelector(`.line[data-side="${side}"]`)?.remove();
      const kept = rowNode.querySelector(".line");
      const number = kept?.querySelector(".line-number");
      if (kept && number && !number.classList.contains("empty")) {
        other.append(rowNode);
      } else {
        rowNode.remove();
      }
    }
  }

  rows.classList.add("editing");
  rows.replaceChildren(
    ...(side === "before" ? [editorPane, other] : [other, editorPane]),
  );
  syncPaneGutter();
  showStatus(result);
  updateActions();

  // The editor occupies the column the click landed in, with the same line
  // metrics, so the caret goes where the pointer was; without one, to the end
  // of the text, where someone arriving from the comparison usually appends.
  // preventScroll keeps focus from moving the page to the element's top.
  fitEditor(textarea);
  const position = caret ?? textarea.value.length;
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(position, position);
}

function beginEdit(side: Side, caret?: number): void {
  if (editing === side) {
    const editor = rows.querySelector<HTMLTextAreaElement>('[data-role="editor"]');
    if (!editor) return;
    editor.focus({ preventScroll: true });
    if (caret !== undefined) editor.setSelectionRange(caret, caret);
    return;
  }
  editing = side;
  renderEdit(caret);
}

/** Character offset at which each line of a text starts. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/**
 * Which line of `text` a rendered line stands for, as a zero-based index.
 * The gutter already carries that side's line number; a padding row has none
 * because the other side inserted there, so it stands just after this side's
 * previous line.
 */
function sideLineIndex(line: HTMLElement, side: Side): number {
  const number = line.querySelector('[data-role="number"]')?.textContent;
  if (number) return Math.max(0, Number(number) - 1);
  let node: Element | null = line.closest(".diff-row");
  while (node) {
    const previous = node.previousElementSibling;
    if (!previous) break;
    const label = previous.querySelector(`[data-side="${side}"] [data-role="number"]`)?.textContent;
    if (label) return Number(label);
    node = previous;
  }
  return 0;
}

/** Characters of `parent` before `target`'s `offset`, flattened. */
function offsetWithin(parent: Node, target: Node, offset: number): number {
  let count = 0;
  const visit = (node: Node): boolean => {
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) {
        count += offset;
      } else {
        const children = Array.from(node.childNodes).slice(0, offset);
        for (const child of children) count += child.textContent?.length ?? 0;
      }
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      count += node.textContent?.length ?? 0;
      return false;
    }
    for (const child of Array.from(node.childNodes)) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(parent);
  return count;
}

/**
 * The caret a click asks for: the clicked line's start plus the characters up
 * to the click itself, as the highlighted text lays them out.
 */
function caretOffsetFor(side: Side, line: HTMLElement, event: MouseEvent): number {
  const text = side === "before" ? beforeText : afterText;
  const starts = lineStarts(text);
  const lineIndex = Math.min(sideLineIndex(line, side), starts.length - 1);
  let column = 0;
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  const rendered = line.querySelector('[data-role="text"]');
  if (range && rendered?.contains(range.startContainer)) {
    column = offsetWithin(rendered, range.startContainer, range.startOffset);
  }
  return Math.min((starts[lineIndex] ?? 0) + column, text.length);
}

function exitEdit(): void {
  if (editing === null) return;
  renderView();
}

function render(delivery: SurfaceDelivery): void {
  const companion = delivery.companion;
  if (!companion) {
    // The host refuses before opening a document whose manifest asked for a
    // comparison; this guard covers a delivery that lost its pair.
    setStatus("历史里还需要另一条文本才能对比", true);
    updateActions();
    return;
  }
  beforeText = companion.text;
  afterText = delivery.item.text;
  currentName = delivery.item.title;
  emptyState.hidden = true;
  currentTitle.textContent = currentName || "当前条目";
  companionTitle.textContent = companion.title || "相邻条目";
  languageLabelElement.textContent = summaryText();
  renderView();
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  updateActions();
  try {
    await action();
  } finally {
    busy = false;
    updateActions();
  }
}

function save(): Promise<void> {
  return run(async () => {
    if (afterText.trim() === "") {
      showStatus(diffText(beforeText, afterText));
      return;
    }
    setStatus("正在保存…");
    const result = await bridge.save(
      afterText,
      (currentName || "对比结果").slice(0, 120),
    );
    if (!result.ok) {
      setStatus(result.message || "保存失败", true);
      return;
    }
    setStatus(result.id === undefined ? "已保存为新条目" : `已保存为新条目 #${result.id}`);
  });
}

function copy(): Promise<void> {
  return run(async () => {
    if (afterText.trim() === "") {
      showStatus(diffText(beforeText, afterText));
      return;
    }
    setStatus("正在复制…");
    const result = await bridge.copy(afterText);
    setStatus(result.ok ? "已复制当前文本" : (result.message || "复制失败"), !result.ok);
  });
}

/** The side a point falls in. Both the view and the editors split evenly. */
function sideAt(x: number): Side {
  const bounds = rows.getBoundingClientRect();
  return x < bounds.left + bounds.width / 2 ? "before" : "after";
}

/**
 * The page's scrollbar, as the stylesheet draws it: a thin 8px bar sitting in
 * the scroller's right edge. A press there is a scrollbar drag, not a click
 * into the text.
 */
const SCROLLBAR_EDGE = 10;

/**
 * What a click asks for: the side it lands on and, when it lands on a rendered
 * line, the caret under the pointer. A click on the pane head, the gutter or
 * the empty area below the last line carries no caret, so that side opens at
 * its end. Returns null for clicks that belong to something else: the editor
 * itself, the footer, or a scrollbar drag.
 */
function editRequest(
  event: MouseEvent,
): { side: Side; caret?: number } | null {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return null;
  if (
    target.closest('[data-role="editor"]')
    || target.closest("footer")
    || target.closest(".doc-head")
  ) {
    return null;
  }
  const head = target.closest<HTMLElement>(".pane-head");
  if (head) {
    const side = head.dataset.side;
    return side === "before" || side === "after" ? { side } : null;
  }
  const line = target.closest<HTMLElement>(".line");
  if (line) {
    const side = line.dataset.side;
    if (side === "before" || side === "after") {
      return { side, caret: caretOffsetFor(side, line, event) };
    }
  }
  // Both panes scroll as one page in edit mode, so anything below a line is
  // an edit request for the side it landed on.
  if (editing !== null) return { side: sideAt(event.clientX) };
  // The vertical scrollbar belongs to the scroller; pressing it scrolls.
  const bounds = scroller.getBoundingClientRect();
  if (event.clientX > bounds.right - SCROLLBAR_EDGE) return null;
  return { side: sideAt(event.clientX) };
}

// A click anywhere in a pane opens that side's editor: on a line it keeps the
// caret where the pointer landed, elsewhere it opens at the end. With an
// editor open, a click on the read-only column moves the editor to the side
// clicked. A drag that selected text stays a selection, so the pointer's
// travel from mouse-down decides.
let downX = 0;
let downY = 0;
document.addEventListener("mousedown", (event) => {
  downX = event.clientX;
  downY = event.clientY;
});
document.addEventListener("click", (event) => {
  if (Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY) > 4) {
    return;
  }
  const request = editRequest(event);
  if (!request) return;
  event.preventDefault();
  beginEdit(request.side, request.caret);
});
// A fast second click is still an edit request, never a word selection — but
// inside the editor a double-click keeps selecting a word.
rows.addEventListener("dblclick", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('[data-role="editor"]')) return;
  event.preventDefault();
});

saveButton.addEventListener("click", () => void save());
closeButton.addEventListener("click", () => bridge.close());
copyButton.addEventListener("click", () => void copy());

// The editor grows with its wrapped text; a narrower or wider window rewraps
// it, so the height is measured again or the page keeps the old line's space.
window.addEventListener("resize", () => {
  const editor = rows.querySelector<HTMLTextAreaElement>('[data-role="editor"]');
  if (editor) fitEditor(editor);
  syncPaneGutter();
});

document.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && (event.key === "Enter" || event.key === "s")) {
    event.preventDefault();
    if (!saveButton.disabled) void save();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    // Escape leaves the editor first; only the next one closes the card.
    if (editing !== null) {
      exitEdit();
      return;
    }
    bridge.close();
  }
});

bridge.onItem(render);
