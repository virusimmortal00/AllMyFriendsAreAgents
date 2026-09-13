import { createInterface } from "node:readline/promises";

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";

function normalize(answer) { return typeof answer === "string" ? answer.trim().toLowerCase() : "cancel"; }
function characters(value) { return [...value]; }
function fit(value, width) {
  const content = characters(value);
  if (content.length <= width) return `${value}${" ".repeat(width - content.length)}`;
  return `${content.slice(0, Math.max(0, width - 1)).join("")}…`;
}
function columns(left, right, width) {
  const gap = width - characters(left).length - characters(right).length;
  return gap > 0 ? `${left}${" ".repeat(gap)}${right}` : fit(left, width);
}
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
function page(write, input) {
  const width = input.width;
  const contentWidth = width - 4;
  if (input.fullscreen) write(CLEAR_SCREEN);
  write(`┌${"─".repeat(width - 2)}┐\n`);
  write(`│ ${fit("AMFAA · ALL MY FRIENDS ARE AGENTS", contentWidth)} │\n`);
  write(`│ ${columns(`FIRST-TIME SETUP${input.preview ? " · PREVIEW" : ""}`, `${input.step} / 3`, contentWidth)} │\n`);
  write(`├${"─".repeat(width - 2)}┤\n`);
  write(`│ ${fit("", contentWidth)} │\n`);
  write(`│ ${fit(input.title, contentWidth)} │\n`);
  write(`│ ${fit("", contentWidth)} │\n`);
  for (const paragraph of input.paragraphs) {
    for (const line of wrap(paragraph, contentWidth)) write(`│ ${fit(line, contentWidth)} │\n`);
    write(`│ ${fit("", contentWidth)} │\n`);
  }
  write(`└${"─".repeat(width - 2)}┘\n\n`);
}

function finalMessage(result, preview) {
  if (preview) return result.code === 0
    ? "Preview complete — no credentials, files, or services were changed.\n"
    : "Setup preview could not complete.\n";
  if (result.completed) return result.start
    ? "✓ Setup complete. Starting AMFAA…\n"
    : "✓ Setup complete. Run `amfaa` when you are ready to start.\n";
  if (result.code === 0) return "Setup paused. Run `amfaa` when you are ready to continue.\n";
  if (result.code === 69) return "Setup could not verify the bundled components. Run `amfaa doctor` for details.\n";
  return "Provider sign-in did not complete. No setup state was saved.\n";
}

async function executeSetupWizard(options) {
  const { ask, authenticate, enterScreen, leaveScreen, persist, preview, project, runtimeReady, write, width, fullscreen } = options;

  page(write, {
    width, fullscreen, preview, step: 1, title: "Checking this installation",
    paragraphs: ["AMFAA is verifying the private Node.js and model runner included with this release. Nothing from your system PATH is used."],
  });
  if (!await runtimeReady()) return { code: 69, completed: false, start: false };

  page(write, {
    width, fullscreen, preview, step: 2, title: "Connect AI models",
    paragraphs: [
      "✓ Installation verified",
      "Your agents need access to at least one AI model. Next, a secure provider menu will open so you can choose OpenRouter or another provider and sign in.",
      "OpenCode — the model runner included with AMFAA — handles and stores the sign-in credential. AMFAA never receives or saves your API key.",
    ],
  });
  const connect = normalize(await ask(preview
    ? "Press Enter to preview provider setup, or Q to finish later: "
    : "Press Enter to open provider setup, or Q to finish later: "));
  if (!fullscreen) write("\n");
  if (["cancel", "n", "no", "q", "quit"].includes(connect)) return { code: 0, completed: false, start: false };
  if (!preview) {
    leaveScreen();
    let code;
    try { code = await authenticate(); }
    finally { enterScreen(); }
    if (code !== 0) return { code, completed: false, start: false };
  }

  page(write, {
    width, fullscreen, preview, step: 3, title: "Choose what happens next",
    paragraphs: [
      preview ? "◇ Provider setup previewed" : "✓ Model provider connected",
      `AMFAA will open for this project: ${project}`,
      "This is only the project for this launch. Start AMFAA from a different directory later to work with that project instead.",
    ],
  });
  const launch = normalize(await ask(preview
    ? "Press Enter to preview launch, or N to stop here: "
    : "Press Enter to start AMFAA, or N to stop here: "));
  if (!fullscreen) write("\n");

  if (preview) return { code: 0, completed: false, start: false };
  if (["cancel", "q", "quit"].includes(launch)) return { code: 0, completed: false, start: false };
  await persist();
  return { code: 0, completed: true, start: launch !== "n" && launch !== "no" };
}

export async function runSetupWizard(options = {}) {
  const write = options.write || ((value) => process.stdout.write(value));
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const fullscreen = options.fullscreen ?? (!options.ask && terminal);
  const width = Math.min(88, Math.max(56, Number(options.width || process.stdout.columns || 72)));
  let screenActive = false;
  const enterScreen = () => {
    if (fullscreen && !screenActive) { write(ENTER_ALTERNATE_SCREEN); screenActive = true; }
  };
  const leaveScreen = () => {
    if (fullscreen && screenActive) { write(LEAVE_ALTERNATE_SCREEN); screenActive = false; }
  };
  let interface_;
  let ask = options.ask;
  if (!ask) {
    interface_ = createInterface({ input: process.stdin, output: process.stdout });
    const answers = interface_[Symbol.asyncIterator]();
    ask = async (prompt) => {
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
      ...options, ask, enterScreen, leaveScreen, fullscreen, preview, width, write,
      runtimeReady: options.runtimeReady || (async () => true),
      authenticate: options.authenticate || (async () => 0),
      persist: options.persist || (async () => undefined),
      project: options.project || process.cwd(),
    });
  } finally {
    interface_?.close();
    leaveScreen();
  }
  write(finalMessage(result, preview));
  return result;
}
