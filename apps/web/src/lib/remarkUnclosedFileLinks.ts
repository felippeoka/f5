import type { PhrasingContent, Root, RootContent } from "mdast";

import { resolveMarkdownFileLinkTarget } from "../markdown-links";

// `[label](<path)`: an angle-bracket destination whose `>` never arrived.
const CANDIDATE = /(?<![!\\])\[([^[\]\r\n]*)\]\([ \t]*<([^<>()\r\n]+)\)(?=$|[\s.,;:!?}\]*_~])/g;

/**
 * Closes `[label](<path)` links whose destination is a local file. Agents
 * write angle-bracket destinations for paths with spaces and sometimes drop
 * the closing `>`, which CommonMark leaves as literal text. Only text nodes
 * whose source bytes equal their value are rewritten, so code, escapes,
 * entities, HTML and existing links keep their original meaning.
 */
export function remarkUnclosedFileLinks(cwd: string | undefined) {
  return (tree: Root, file: { readonly value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : null;
    if (source === null || !/\]\([ \t]*</.test(source)) return;
    const walk = (parent: Root | RootContent) => {
      if (
        ["link", "linkReference", "code", "inlineCode", "html"].includes(parent.type) ||
        !("children" in parent)
      )
        return;
      const children: RootContent[] = [];
      for (const node of parent.children) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (
          node.type !== "text" ||
          start === undefined ||
          end === undefined ||
          source.slice(start, end) !== node.value
        ) {
          walk(node);
          children.push(node);
          continue;
        }
        let offset = 0;
        for (const match of node.value.matchAll(CANDIDATE)) {
          const destination = match[2]!.trim();
          if (resolveMarkdownFileLinkTarget(destination, cwd) === null) continue;
          if (match.index > offset)
            children.push({ type: "text", value: node.value.slice(offset, match.index) });
          children.push({
            type: "link",
            url: destination,
            children: [{ type: "text", value: match[1]! }],
          });
          offset = match.index + match[0].length;
        }
        if (!offset) children.push(node);
        else if (offset < node.value.length)
          children.push({ type: "text", value: node.value.slice(offset) });
      }
      // Every replacement of a text node remains phrasing content.
      parent.children = children as PhrasingContent[] & RootContent[];
    };
    walk(tree);
  };
}
