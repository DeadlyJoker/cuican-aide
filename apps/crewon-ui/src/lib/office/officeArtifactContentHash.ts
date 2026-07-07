function decodeBase64Bytes(dataBase64: string): Uint8Array<ArrayBuffer> {
  const decode =
    typeof window !== "undefined" && window.atob
      ? window.atob.bind(window)
      : globalThis.atob;
  const binary = decode(dataBase64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function sha256Base64(dataBase64: string): Promise<string | null> {
  const subtle =
    globalThis.crypto?.subtle ??
    (typeof window !== "undefined" ? window.crypto?.subtle : undefined);
  if (!subtle) {
    return null;
  }

  try {
    const digest = await subtle.digest("SHA-256", decodeBase64Bytes(dataBase64));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}
