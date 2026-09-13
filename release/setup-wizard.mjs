import { createInterface } from "node:readline/promises";

const line = "─".repeat(52);

function normalize(answer) { return answer.trim().toLowerCase(); }

async function executeSetupWizard(options) {
  const preview = options.preview === true;
  const ask = options.ask;
  const write = options.write || ((value) => process.stdout.write(value));
  const runtimeReady = options.runtimeReady || (async () => true);
  const authenticate = options.authenticate || (async () => 0);
  const persist = options.persist || (async () => undefined);
  const project = options.project || process.cwd();

  write(`\n╭${line}╮\n`);
  write("│  AMFAA · All My Friends Are Agents                 │\n");
  write(`│  First-time setup${preview ? " · PREVIEW" : ""}${" ".repeat(preview ? 22 : 32)}│\n`);
  write(`╰${line}╯\n\n`);
  write("This takes about a minute. Provider credentials stay with OpenCode.\n\n");

  write("[1/3] Application runtime\n");
  if (!await runtimeReady()) {
    write("  ✗ The verified bundled runtime is unavailable.\n");
    return { code: 69, completed: false, start: false };
  }
  write("  ✓ Verified bundled runtime is ready.\n\n");

  write("[2/3] Model provider\n");
  write("  AMFAA will hand provider sign-in to its bundled OpenCode runtime.\n");
  const connect = normalize(await ask("  Connect a model provider now? [Y/n] "));
  if (connect === "n" || connect === "no" || connect === "q" || connect === "quit") {
    write("\nSetup paused. Run `amfaa` when you are ready to continue.\n");
    return { code: 0, completed: false, start: false };
  }
  if (preview) write("  ◇ Preview: OpenCode's provider sign-in would open here.\n");
  else {
    const code = await authenticate();
    if (code !== 0) {
      write("  ✗ Provider sign-in did not complete. No setup state was saved.\n");
      return { code, completed: false, start: false };
    }
    write("  ✓ Provider sign-in completed.\n");
  }

  write("\n[3/3] Launch\n");
  write(`  Project for this launch: ${project}\n`);
  write("  You can launch from another directory later; this choice is not permanent.\n");
  const launch = normalize(await ask("  Start AMFAA after setup? [Y/n] "));

  if (preview) {
    write("\nPreview complete — no credentials, files, or services were changed.\n");
    if (launch !== "n" && launch !== "no") write("A real run would now start AMFAA for this project.\n");
    return { code: 0, completed: false, start: false };
  }

  await persist();
  write("\n✓ Setup complete. Run `amfaa setup` any time to reconnect a provider.\n");
  return { code: 0, completed: true, start: launch !== "n" && launch !== "no" };
}

export async function runSetupWizard(options = {}) {
  if (options.ask) return executeSetupWizard(options);
  const interface_ = createInterface({ input: process.stdin, output: process.stdout });
  const answers = interface_[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    process.stdout.write(prompt);
    const answer = await answers.next();
    return answer.done ? "" : answer.value;
  };
  try { return await executeSetupWizard({ ...options, ask }); }
  finally { interface_.close(); }
}
