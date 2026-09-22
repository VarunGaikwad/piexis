import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFindToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Expose Pi's gitignore-aware file globber under the familiar glob name. */
export default function glob(pi: ExtensionAPI) {
  const find = createFindToolDefinition(process.cwd());

  pi.registerTool({
    ...find,
    name: "glob",
    label: "glob",
    description:
      "Find files by glob pattern. Supports patterns such as '*.ts', '**/*.json', and 'src/**/*.spec.ts'; respects .gitignore. Returns paths relative to the search directory. Output is truncated to 1,000 results or 50KB.",
    promptSnippet: "Find files by glob pattern (respects .gitignore)",
    promptGuidelines: [
      "Use glob to discover files by pathname pattern before reading or editing them."
    ],
    renderCall(args, theme, context) {
      const text =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);
      const path = args.path ?? ".";
      const limit = args.limit == null ? "" : ` (limit ${args.limit})`;
      text.setText(
        `${theme.fg("toolTitle", theme.bold("glob"))} ${theme.fg("accent", args.pattern)}${theme.fg("toolOutput", ` in ${path}${limit}`)}`
      );
      return text;
    }
  });
}
