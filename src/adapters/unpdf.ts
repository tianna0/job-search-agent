import { extractText, getDocumentProxy } from "unpdf";
import type { PdfReader } from "../core/types.ts";

/** PDF text extraction that works in both Node and Cloudflare Workers. */
export const unpdfReader: PdfReader = {
  async toText(bytes) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  },
};
