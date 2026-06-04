// 128x128 dumbbell icon (PNG), base64-embedded. Served unauthenticated at
// /favicon.png and referenced by `logo_uri` in the OAuth metadata + serverInfo
// icons — that's how a connector card gets an icon (see CLAUDE.md "Icon").
// Swap this string to change the icon (e.g. a real Hevy logo PNG).
export const FAVICON_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAADHklEQVR4nO2dS3LbMBAFQVaO4MoqOYnvlUPkXjlJtFLpDvHCJUWWRBIgCMwMXvfKXxGY1xyAKH+m1IG37z/+9bjOaFzOp6n1NZpcgMDb0EKIQ1+Q4PtwpAjVL0TottTKMNd8M+HbU5vBLnsI3id7ukFxByB8v+zJpkgAwvdPaUbZAhB+HEqyyhKA8OORm9mmAIQfl5zsVgUg/PhsZbgoAOGPw1qWLwUg/PFYyrTqJBDi8yQAd/+4vMp23voCGIvHjFkCxEEAcW4C0P51uM+aDiDOnBJ3vyLXzOkA4iCAOAggzsT6rw0dQBwEEAcBxEEAcRBAHAQQBwHEQQBxEEAcBBAHAcRBAHEQQBwEEAcBxEEAcb5ZD+Ce919/b2//+f3z6f1oRJiPmw5wX5w9n/dGlPm4ECC3GF6KtkWk+ZgLUFoED0VbI9p8zAUAWxBAHAQQBwHE6XIO8LjR8fIM7JHetWoqwNIO9/pxRPiPVa2aLQE5jzfWj0BesKwVewBxmgjAnd2GFnWlA4iDAOIggDgIII6rHwgpxdNmM+qZRtgO4Cn8lPyNJ5eQAngtttdxrRFSADgOBBAHAcRBAHEQQBwEECekAF4PXbyOa42QAqTkr9jexpNL6KPgqEX3RNgOAMeAAOIggDgIIE4TAdictaFFXekA4jQTIMdWOsUnlrVqeg5wHTS/G7iNVa26HAQReD69a8UeQBwEEAcBxEEAccwFKN30eN9QRpuPuQAp5RfBuli5RJqPCwFS2i6Gh2KVEGU+/Pdwcdx0ALABAcRBAHEQQBwEEAcBxEEAcRBAHAQQBwHEQQBxEEAcBBAHAcRBAHHmy/k0WQ8CbLicTxMdQBwEEAcBxJlT+lwLrAcCfblmTgcQ5yYAXUCH+6zpAOIggDhfBGAZGJ/HjJ86ABKMy6tsWQLEeSkAXWA8ljJd7ABIMA5rWa4uAUgQn60MN/cASBCXnOyyNoFIEI/czLKfApAgDiVZFT0GIoF/SjMqPgdAAr/syaYqTP6+kA9qbsqqk0C6gT21GRwaIB2hD0feeE3uYERoQ4uO26WFI8Q+eiyxH3XwAlfyKIGsAAAAAElFTkSuQmCC";

/** Decode the embedded PNG to an ArrayBuffer for serving as a Response body. */
export function faviconPngBytes(): ArrayBuffer {
  const bin = atob(FAVICON_PNG_B64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

export const FAVICON_DATA_URI = `data:image/png;base64,${FAVICON_PNG_B64}`;
