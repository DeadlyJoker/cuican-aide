export function decodeBase64Text(dataBase64: string): string {
  const bytes = Uint8Array.from(window.atob(dataBase64), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

export function encodeCapabilityActionPayload(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

export function decodeCapabilityActionPayload<T>(value: string): T | null {
  try {
    return JSON.parse(decodeURIComponent(value)) as T;
  } catch {
    return null;
  }
}
