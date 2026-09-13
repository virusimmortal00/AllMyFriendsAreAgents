import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";

function normalize(answer) { return typeof answer === "string" ? answer.trim().toLowerCase() : "cancel"; }
function terminalText(value) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    const code = character.codePointAt(0).toString(16).padStart(2, "0");
    return `\\x${code}`;
  });
}
function characters(value) { return [...value]; }
function wrap(value, width) {
  const words = value.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (characters(word).length > width) {
      if (current) { lines.push(current); current = ""; }
      const content = characters(word);
      while (content.length > width) lines.push(content.splice(0, width).join(""));
      current = content.join("");
    } else if (!current || characters(`${current} ${word}`).length <= width) current = current ? `${current} ${word}` : word;
    else { lines.push(current); current = word; }
  }
  if (current || !lines.length) lines.push(current);
  return lines;
}
function paint(value, code, color) {
  return color ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function styledText(value, style, color) {
  if (!color) return value;
  const brands = { OpenRouter: "38;2;200;255;0", OpenCode: "38;2;130;170;255" };
  const highlighted = value.replace(/\b(OpenRouter|OpenCode)\b/g, name =>
    `\u001b[${brands[name]}m${name}\u001b[0${style ? `;${style}` : ""}m`);
  return style ? paint(highlighted, style, true) : highlighted;
}

function page(write, input) {
  const { width, color } = input;
  const contentWidth = width - 2;
  const lineCount = (input.compact ? 4 : 8) + wrap(input.title, contentWidth).length
    + input.paragraphs.reduce((sum, text) => sum + wrap(text, contentWidth).length + 1, 0);
  const fullscreen = input.fullscreen && (input.paged || lineCount + (input.compact ? 7 : 9) <= input.rows);
  if (!fullscreen) input.leaveScreen?.();
  if (fullscreen) { input.enterScreen?.(); write(CLEAR_SCREEN); }
  let writtenLines = 0;
  const row = (text = "", style) => {
    for (const line of wrap(text, contentWidth)) {
      write(`  ${styledText(line, style, color)}\n`);
      writtenLines++;
    }
  };
  if (!input.compact) { write("\n"); writtenLines++; }
  if (!input.minimal) row(`AMFAA  /  ${input.preview ? "SETUP · PREVIEW" : "SETUP"}  /  ${input.step} / 4`, "2");
  if (!input.compact) row();
  if (input.topPadding) { write("\n".repeat(input.topPadding)); writtenLines += input.topPadding; }
  const faceLine = writtenLines;
  row(input.face || "[ o‿o ]", "92");
  if (!input.minimal) row(input.title, "1");
  row();
  for (const paragraph of input.paragraphs) {
    row(paragraph);
    row();
  }
  return { fullscreen, writtenLines, faceOffset: writtenLines - faceLine };
}

function welcomeSplash(options) {
  const { write, rows, color, fullscreen, enterScreen } = options;
  const width = options.terminalWidth || options.width;
  if (fullscreen) { enterScreen(); write(CLEAR_SCREEN); }
  const face = "[ o‿o ] Consolio";
  const indent = " ".repeat(Math.max(2, Math.floor((width - face.length) / 2)));
  const lines = wrap("Let's see where this takes us.", width - 4);
  const a = ["       ", "  __ _ ", " / _` |", "| (_| |", " \\__,_|"];
  const letters = [
    { rows: a, rgb: "97;187;70" },
    { rows: ["           ", " _ __ ___  ", "| '_ ` _ \\ ", "| | | | | |", "|_| |_| |_|"], rgb: "253;184;39" },
    { rows: [" __ ", "/ _|", "| |_", "|  _", "|_| "], rgb: "245;130;31" },
    { rows: a, rgb: "224;58;62" },
    { rows: a, rgb: "150;61;151" },
  ];
  const artwork = a.map((_, row) => letters.map(letter => letter.rows[row]).join(""));
  const artworkWidth = Math.max(...artwork.map(line => line.length));
  const banner = width >= artworkWidth + 4 && rows >= 18 ? artwork : ["amfaa"];
  const bannerWidth = Math.max(...banner.map(line => line.length));
  const bannerIndent = " ".repeat(Math.max(0, Math.floor((width - bannerWidth) / 2)));
  const contentRows = 10 + lines.length + banner.length;
  write("\n".repeat(Math.max(1, Math.floor((rows - contentRows) / 2))));
  for (const [row, line] of banner.entries()) {
    const text = banner === artwork
      ? letters.map(letter => paint(letter.rows[row], `1;38;2;${letter.rgb}`, color)).join("")
      : [...line].map((letter, index) => paint(letter, `1;38;2;${letters[index].rgb}`, color)).join("");
    write(`${bannerIndent}${text}\n`);
  }
  write("\n\n");
  write(`${indent}${paint(face, "92", color)}\n\n\n`);
  for (const line of lines) write(`${" ".repeat(Math.max(2, Math.floor((width - line.length) / 2)))}${line}\n`);
  write("\n\n\n");
  return { offset: 6 + lines.length, indent };
}

// The terminal owns selection only while this promise is pending. In particular,
// restore cooked input and remove our listeners before OpenCode asks for a key.
export async function selectSetupOption({ items, input = process.stdin, output = process.stdout, color = false, width = 72, rows = 24, animation, anyKey = false, anyKeyLabel = "Press any key to continue", redrawSplash }) {
  const write = value => output.write(value);
  const wasRaw = input.isRaw === true;
  const wasPaused = input.isPaused();
  let selected = 0;
  let drawnLines = 0;
  let animationTimer;
  let frame = 0;
  const stopAnimation = () => { clearInterval(animationTimer); animationTimer = undefined; };
  const render = () => {
    if (drawnLines) write(`\u001b[${drawnLines}A\r\u001b[J`);
    const lines = [];
    if (anyKey) {
      const label = anyKeyLabel;
      lines.push(`${" ".repeat(Math.max(2, Math.floor((width - label.length) / 2)))}${paint(label, "1", color)}`);
    }
    for (const [index, item] of (anyKey ? [] : items).entries()) {
      const active = index === selected;
      const wrapped = wrap(item.label, Math.max(4, width - 6));
      wrapped.forEach((line, part) => {
        const text = `  ${active && part === 0 ? "›" : " "} ${line}`;
        lines.push(active ? paint(text, "1;92", color) : text);
      });
    }
    if (!anyKey) lines.push("", ...wrap("↑/↓ move · Enter selects · Esc exits", Math.max(4, width - 2)).map(line => `  ${line}`));
    write(`${lines.join("\n")}\n`);
    drawnLines = lines.length;
  };
  emitKeypressEvents(input);
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      stopAnimation();
      output.removeListener?.("resize", onResize);
      input.removeListener("keypress", onKey);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      write("\u001b[?25h");
    };
    const finish = value => { cleanup(); resolve(value); };
    const startAnimation = () => {
      if (!animation || animation.offset + drawnLines >= rows) return;
      animationTimer = setInterval(() => {
        const faces = ["[ o_o ]", "[ o_o ]", "[ -_- ]", "[ o_o ]", "[ o‿o ]", "[ o‿o ]"];
        const face = `${faces[frame++ % faces.length]} Consolio`;
        write(`\u001b7\u001b[${animation.offset + drawnLines}A\r\u001b[2K${animation.indent || "  "}${paint(face, "92", color)}\u001b8`);
      }, 450);
    };
    const onResize = () => {
      stopAnimation();
      if (!redrawSplash) return;
      try {
        width = Math.max(8, output.columns || width);
        rows = output.rows || rows;
        const layout = redrawSplash(width, rows);
        if (animation) animation = layout;
        drawnLines = 0;
        render();
        startAnimation();
      } catch (error) { onError(error); }
    };
    const onEnd = () => finish("quit");
    const onError = error => { cleanup(); reject(error); };
    const onKey = (text, key = {}) => {
      if (key.ctrl && ["c", "d"].includes(key.name)) return finish("quit");
      if (anyKey) return finish("continue");
      if (key.name === "escape" || text === "q") return finish("quit");
      if (key.name === "return" || key.name === "enter") return finish(items[selected].value);
      if (key.name === "up") selected = (selected + items.length - 1) % items.length;
      else if (key.name === "down" || key.name === "tab") selected = (selected + 1) % items.length;
      else {
        const index = items.findIndex(item => item.key === text?.toLowerCase());
        if (index < 0) return;
        selected = index;
      }
      render();
    };
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("error", onError);
    try {
      input.setRawMode(true);
      write("\u001b[?25l");
      render();
      if (animation || redrawSplash) output.on?.("resize", onResize);
      startAnimation();
      input.resume();
    } catch (error) { onError(error); }
  });
}

function finalMessage(result, preview, roomUrl) {
  if (preview) return result.code === 0
    ? "Preview complete — no credentials, files, or services were changed.\n"
    : "Setup preview could not complete.\n";
  if (result.completed) return result.start
    ? "✓ Setup saved. Starting your room in the background…\n"
    : "✓ Setup complete. The gang can wait. Run `amfaa start` from your project folder when you are ready.\n";
  if (result.code === 0) return "I'll be here when you're ready. Run `amfaa` to get going again.\n";
  if (result.code === 69) return "A small detour: I couldn't verify the bundled components. Run `amfaa doctor` for details, then try `amfaa` again.\n";
  return "We didn't quite finish the OpenRouter step. Run `amfaa setup` and we'll give it another go.\n";
}

async function executeSetupWizard(options) {
  const { ask, authenticate, enterScreen, leaveScreen, persist, preview, project, runtimeReady, write } = options;
  let currentPage;
  let pendingPage;
  const show = (input) => { pendingPage = input; if (!options.select || !options.fullscreen) currentPage = page(write, { ...options, ...input }); };
  const selectChoice = async (question, items, choices, faceOffset) => {
    const questionLines = question ? wrap(question, options.width - 2) : [];
    if (currentPage?.fullscreen && options.select) {
      const menuLines = items.reduce((sum, item) => sum + wrap(item.label, Math.max(4, options.width - 6)).length, 0)
        + 1 + wrap("↑/↓ move · Enter selects · Esc exits", Math.max(4, options.width - 2)).length;
      // Leave the cursor on the last row without scrolling the heading away.
      const padding = Math.max(0, options.rows - 1 - currentPage.writtenLines - questionLines.length - 1 - menuLines);
      write("\n".repeat(padding));
    }
    for (const line of questionLines) write(`  ${styledText(line, "1", options.color)}\n`);
    write("\n");
    if (options.select) return options.select(items, faceOffset === undefined ? undefined : { offset: faceOffset + questionLines.length + 1 });
    while (true) {
      for (const [index, item] of items.entries()) write(`  ${index + 1}. ${item.label}\n`);
      const answer = normalize(await ask("Choose a number (Enter: 1, Q: exit) > "));
      if (!options.fullscreen) write("\n");
      if (["cancel", "q", "quit"].includes(answer)) return "quit";
      if (answer === "") return items[0].value;
      if (/^[1-9]$/.test(answer) && items[Number(answer) - 1]) return items[Number(answer) - 1].value;
      if (Object.hasOwn(choices, answer)) return choices[answer];
      write("Choose one of the options below, or Q to finish later.\n");
    }
  };
  const choose = async (question, items, choices) => {
    if (!options.select || !options.fullscreen) return selectChoice(question, items, choices);
    const navigation = [
      { label: "Sure, go on", value: "next" },
      { label: "Previous page", value: "previous" },
      { label: "Finish later", value: "quit" },
    ];
    const finalItems = [...items, { label: "Previous page", value: "previous" }];
    const menuHeight = list => list.reduce((sum, item) => sum + wrap(item.label, Math.max(4, options.width - 6)).length, 0)
      + 1 + wrap("↑/↓ move · Enter selects · Esc exits", Math.max(4, options.width - 2)).length;
    const title = pendingPage.heading ?? ({ 2: "Let's get connected.", 3: "Let's give that key a home.", 4: "Let's meet the gang." })[pendingPage.step];
    const minimal = options.rows < 20;
    const budget = Math.max(2, options.rows - 1 - (minimal ? 2 : 3 + wrap(title, options.width - 2).length)
      - Math.max(wrap(question, options.width - 2).length + 1, 2)
      - Math.max(menuHeight(finalItems), menuHeight(navigation)));
    const chunks = [];
    let chunk = [], used = 0;
    for (const paragraph of [pendingPage.title, ...pendingPage.paragraphs]) {
      const lines = wrap(paragraph, options.width - 2);
      if (used + lines.length + 1 > budget && chunk.length) { chunks.push(chunk); chunk = []; used = 0; }
      while (lines.length + 1 > budget) chunks.push([lines.splice(0, budget - 1).join(" ")]);
      if (lines.length) { chunk.push(lines.join(" ")); used += lines.length + 1; }
    }
    if (chunk.length) chunks.push(chunk);
    for (let index = 0;;) {
      const last = index === chunks.length - 1;
      const pageItems = last ? (index ? finalItems : items) : (index ? navigation : navigation.filter(item => item.value !== "previous"));
      const pageQuestion = last ? question : "";
      const questionHeight = pageQuestion ? wrap(pageQuestion, options.width - 2).length : 0;
      const bodyHeight = (minimal ? 2 : 3 + wrap(title, options.width - 2).length)
        + chunks[index].reduce((sum, paragraph) => sum + wrap(paragraph, options.width - 2).length + 1, 0);
      const spareRows = Math.max(0, options.rows - 1 - bodyHeight - questionHeight - 1 - menuHeight(pageItems));
      // Balance space around the guide, including existing paragraph spacing.
      // Metadata stays at the top; the question and actions keep their bottom anchor.
      const topPadding = Math.min(spareRows, Math.max(0, Math.floor((spareRows + 1 + (pageQuestion ? 0 : 1) - (minimal ? 0 : 1)) / 2)));
      currentPage = page(write, { ...options, ...pendingPage, title, paragraphs: chunks[index], compact: true, minimal, paged: true, topPadding });
      const answer = await selectChoice(pageQuestion, pageItems, choices);
      if (answer === "previous") { index--; continue; }
      if (!last && answer === "next") { index++; continue; }
      return answer;
    }
  };
  const splash = welcomeSplash(options);
  const welcome = options.select
    ? await options.select([], splash, true)
    : (await ask("Press Enter to continue ")) === undefined ? "quit" : "continue";
  if (welcome === "quit") return { code: 0, completed: false, start: false };
  write("\nChecking that everything's here…\n");
  if (!await runtimeReady()) return { code: 69, completed: false, start: false };

  let connection = "manual";
  const existing = !preview && await options.configured?.().catch(() => false);
  while (true) {
    show({ step: 2, title: "Hello there! I'm Consolio, your computorial guide in getting setup with amfaa.",
      paragraphs: [
        "First thing's first - we need to get you hooked up with OpenRouter.",
        "OpenRouter will let us hook up your new agentic buddies and/or coworkers and/or enemies into models from a variety of providers (which is rad).",
        "Connect in your browser, paste a key you already have, or configure it yourself later.",
        "The lawyers want me to mention that: Model usage is billed to your OpenRouter account.",
        ...(existing ? ["I found an existing OpenRouter configuration. We can use that. No live connection has been tested."] : []),
      ],
    });
    const method = await choose("How would you like to connect?", [
      ...(existing ? [{ label: "Use existing configuration", value: "existing" }] : []),
      { label: "Connect in my browser", value: "browser" },
      { label: "I have an API key", value: "key", key: "k" },
      { label: "I'll configure it myself later", value: "manual", key: "m" },
      { label: "Finish later", value: "quit", key: "q" },
    ], { k: "key", m: "manual" });
    if (method === "quit") return { code: 0, completed: false, start: false };
    if (method === "existing") { connection = "existing"; break; }
    if (method === "manual") {
      show({ step: 3, heading: "Connect whenever you are ready.", title: "Prefer to do the wiring yourself? Rad.", paragraphs: [
        "Run amfaa setup later to connect in your browser or save a key.",
        'Or put your key directly in your global OpenCode config: ~/.config/opencode/opencode.json, under provider.openrouter.options.apiKey.',
        "Environment-only keys and .env files are not supported for room conversations. Keep credentials out of Git.",
        "We'll finish setup without connecting. Your agents will need that configuration before they can respond. Run amfaa setup whenever you'd like my help again.",
      ] });
      const manual = await choose("Finish setup without connecting?", [
        { label: "Finish setup", value: "finish" }, { label: "Back", value: "back", key: "b" },
      ], { b: "back" });
      if (manual === "quit") return { code: 0, completed: false, start: false };
      if (manual === "back") continue;
      break;
    }
    let selectedMethod = method;
    show({ step: 3, title: method === "browser" ? "Let's take a little trip to OpenRouter." : "Let's give that key a home.",
      paragraphs: method === "browser" ? [
        "Sign in to OpenRouter in your browser and approve access. I'll handle the key behind the scenes and save it on this computer.",
        "Using SSH or a container? Choose another browser, then paste the one-time authorization code back here.",
        ...(preview ? ["Preview only: the next screen simulates approval. No browser opens and no credentials are created or saved."] : []),
      ] : [
        "Paste your OpenRouter API key into my hidden prompt, then press Enter. I'll save it on this computer using the bundled runtime.",
        "Need a key? Create one at https://openrouter.ai/settings/keys.",
        ...(preview ? ["Preview only: key entry is skipped. Please don't paste a real key into this preview."] : []),
      ],
    });
    const ready = await choose("Ready?", [
      { label: preview ? "Continue preview" : method === "browser" ? "Open browser here" : "Enter my key", value: "ready" },
      ...(method === "browser" ? [{ label: "Use another browser (SSH)", value: "headless" }] : []),
      { label: "Back", value: "back", key: "b" },
    ], { b: "back" });
    if (ready === "quit") return { code: 0, completed: false, start: false };
    if (ready === "back") continue;
    if (ready === "headless") selectedMethod = "headless";
    if (preview) { connection = "preview"; break; }
    leaveScreen(); options.releaseInput?.();
    write(styledText(selectedMethod === "key" ? "\nPaste your OpenRouter key. Input is hidden; Enter saves, Esc cancels.\n" : "\nLet's connect OpenRouter.\n", undefined, options.color));
    let code;
    try { code = await authenticate(selectedMethod, { write }); }
    catch { code = 1; }
    finally { enterScreen(); }
    if (code === 0) { connection = "saved"; break; }
    show({ step: 3, heading: "Let's try that connection again.", title: "Hm. That connection didn't finish.", paragraphs: [
      "The request may have been cancelled, expired, or failed to save. We can try again or choose another way to connect.",
      "Setup is not marked complete. Any credentials already saved remain on this computer.",
    ] });
    const retry = await choose("Give it another go?", [
      { label: "Try again", value: "retry" }, { label: "Finish later", value: "quit", key: "q" },
    ], {});
    if (retry === "quit") return { code, completed: false, start: false };
  }

  show({ step: 4, face: "[ ^‿^ ]", title: connection === "saved" ? "Key saved! Let's get the gang together." : "Here's where the gang will gather.",
    paragraphs: [
      connection === "preview" ? "Preview only: no key was saved and no connection was made." : connection === "manual" ? "OpenRouter is not connected yet. You can finish configuration later." : connection === "existing" ? "We'll use your existing configuration. No live model request has been tested." : "Your key is saved. No live model request has been tested.",
      `Your project folder: ${terminalText(project)}`,
      "Your new crew can inspect this folder for context. Ordinary room conversations cannot edit its files.",
      "Want a different folder? Stop here, then run amfaa from the folder you want.",
      "Once the room loads, open Manage agents… to add your first two agents. Friends, rivals - your call.",
      options.sandbox ? "Your room will run in the background inside this disposable container. I will return you to the sandbox shell; keep the container open while testing." : "I can keep your room running in the background. You can close this terminal once it starts.",
      "Check on it: amfaa status. Stop it: amfaa stop. Your room and connection stay saved.",
      "To start again, run amfaa start from your project folder. You will also do this after restarting your computer.",
    ],
  });
  const launch = await choose("Ready to meet the gang?", [
    { label: preview ? "Preview background launch" : "Start in the background", value: "start" },
    { label: preview ? "Stop here" : "Save and exit", value: "stop", key: "n" },
  ], { y: "start", yes: "start", n: "stop", no: "stop" });
  if (launch === "quit") return { code: 0, completed: false, start: false };
  const farewell = "Just remember, at the end of the day, there is no greater gift than friendship.  Well... money is probably better, but besides that - probably friendship.";
  const lines = wrap(farewell, options.width - 4);
  const label = "Press any key to finish setup";
  const full = options.fullscreen && lines.length + 6 <= options.rows;
  if (full) { enterScreen(); write(CLEAR_SCREEN); }
  else leaveScreen();
  const padding = full ? Math.max(0, Math.floor((options.rows - lines.length - 6) / 2)) : 1;
  write("\n".repeat(padding));
  write(`  ${paint("[ ^‿^ ] Consolio", "92", options.color)}\n\n`);
  for (const line of lines) write(`  ${line}\n`);
  write("\n".repeat(full ? Math.max(1, options.rows - padding - lines.length - 4) : 1));
  const goodbye = options.select
    ? await options.select([], undefined, true, label)
    : (await ask("Press Enter to finish setup ")) === undefined ? "quit" : "continue";
  if (goodbye === "quit" || preview) return { code: 0, completed: false, start: false };
  await persist();
  return { code: 0, completed: true, start: launch === "start" };
}

export async function runSetupWizard(options = {}) {
  const write = options.write || ((value) => process.stdout.write(value));
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  // Use ordinary scrollback on small terminals so long pages and actions remain reachable.
  const requestedWidth = Number(options.width || process.stdout.columns || 72);
  const width = Math.min(80, Math.max(8, Number.isFinite(requestedWidth) ? Math.floor(requestedWidth) : 72));
  const rows = Number(options.rows || process.stdout.rows || 24);
  const fullscreen = options.fullscreen ?? (!options.ask && terminal);
  const terminalWidth = Math.max(8, Number.isFinite(requestedWidth) ? Math.floor(requestedWidth) : 72);
  const color = options.color ?? (terminal && !Object.hasOwn(process.env, "NO_COLOR") && process.env.TERM !== "dumb");
  let screenActive = false;
  const enterScreen = () => {
    if (fullscreen && !screenActive) { write(ENTER_ALTERNATE_SCREEN); screenActive = true; }
  };
  const leaveScreen = () => {
    if (fullscreen && screenActive) { write(LEAVE_ALTERNATE_SCREEN); screenActive = false; }
  };
  let interface_;
  const releaseInput = () => { interface_?.close(); interface_ = undefined; };
  let ask = options.ask;
  if (!ask) {
    let answers;
    ask = async (prompt) => {
      // Release stdin entirely during OpenCode's password prompt. Do not queue
      // credential input in the wizard's line reader while the child owns it.
      if (!interface_) {
        interface_ = createInterface({ input: process.stdin, output: process.stdout });
        answers = interface_[Symbol.asyncIterator]();
      }
      process.stdout.write(prompt);
      const answer = await answers.next();
      return answer.done ? undefined : answer.value;
    };
  }

  const preview = options.preview === true;
  let result;
  enterScreen();
  try {
    result = await executeSetupWizard({
      ...options, ask, enterScreen, leaveScreen, releaseInput, fullscreen, preview, width, terminalWidth, rows, color, write,
      select: options.select || (!options.ask && terminal && process.env.TERM !== "dumb"
        ? (items, animation, anyKey, anyKeyLabel) => selectSetupOption({ items, color, width: anyKey && !anyKeyLabel ? terminalWidth : width, rows, anyKey, anyKeyLabel,
          redrawSplash: anyKey && !anyKeyLabel ? (columns, height) => welcomeSplash({ write, width: columns, terminalWidth: columns, rows: height, color, fullscreen, enterScreen }) : undefined,
          animation: process.env.ALL_MY_FRIENDS_ARE_AGENTS_NO_ANIMATION === "1" ? undefined : animation }) : undefined),
      runtimeReady: options.runtimeReady || (async () => true),
      authenticate: options.authenticate || (async () => { throw new Error("Authentication is unavailable."); }),
      persist: options.persist || (async () => undefined),
      project: options.project || process.cwd(),
    });
  } finally {
    interface_?.close();
    leaveScreen();
  }
  const port = Number(options.port || 53147);
  const roomUrl = `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port <= 65535 ? port : 53147}`;
  write(styledText(finalMessage(result, preview, roomUrl), undefined, color));
  return result;
}
