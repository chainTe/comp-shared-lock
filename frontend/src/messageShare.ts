export function messageSharePath(channelHash: string, txHash: string): string {
  return `/channel/${encodeURIComponent(channelHash)}/message/${encodeURIComponent(txHash)}`;
}

export function messageShareUrl(
  channelHash: string,
  txHash: string,
  currentUrl = window.location.href,
): string {
  const url = new URL(currentUrl);
  url.hash = `#${messageSharePath(channelHash, txHash)}`;
  return url.toString();
}

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Some browsers expose Clipboard API but block it outside a secure context.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard access was denied");
}

export async function copyMessageLink(
  channelHash: string,
  txHash: string,
): Promise<string> {
  const url = messageShareUrl(channelHash, txHash);
  await copyText(url);
  return url;
}
