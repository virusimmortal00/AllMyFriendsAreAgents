import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEVELOPER_TOKEN_FILE = "developer-token";

function configuredToken(environment: NodeJS.ProcessEnv) {
  const token = environment.ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TOKEN?.trim();
  if (token && token.length < 32) {
    throw new Error("ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TOKEN must be at least 32 characters.");
  }
  return token;
}

export function developerTokenPath(dataDirectory: string) {
  return path.join(dataDirectory, DEVELOPER_TOKEN_FILE);
}

export async function openDeveloperToken(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const fromEnvironment = configuredToken(environment);
  if (fromEnvironment) return { token: fromEnvironment, source: "environment" as const };

  await mkdir(dataDirectory, { recursive: true });
  const tokenPath = developerTokenPath(dataDirectory);
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (token.length < 32) throw new Error(`Developer token at ${tokenPath} is invalid.`);
    await chmod(tokenPath, 0o600);
    return { token, source: tokenPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { token, source: tokenPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (existing.length < 32) throw new Error(`Developer token at ${tokenPath} is invalid.`);
    return { token: existing, source: tokenPath };
  }
}

export async function readDeveloperToken(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const fromEnvironment = configuredToken(environment);
  if (fromEnvironment) return fromEnvironment;
  const tokenPath = developerTokenPath(dataDirectory);
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (token.length < 32) throw new Error(`Developer token at ${tokenPath} is invalid.`);
  return token;
}

export function developerRequestAuthorized(authorization: string | undefined, expectedToken: string) {
  if (!authorization?.startsWith("Bearer ")) return false;
  const suppliedToken = authorization.slice("Bearer ".length).trim();
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
