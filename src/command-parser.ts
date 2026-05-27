export type ParsedInput =
  | { type: "command"; name: string; args: string }
  | { type: "message"; text: string };

export function parseInput(text: string): ParsedInput {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) {
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) {
      return { type: "command", name: trimmed.slice(1).toLowerCase(), args: "" };
    }
    return {
      type: "command",
      name: trimmed.slice(1, spaceIdx).toLowerCase(),
      args: trimmed.slice(spaceIdx + 1).trim(),
    };
  }
  return { type: "message", text: trimmed };
}
