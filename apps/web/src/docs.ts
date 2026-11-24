import solml from "../../../spec/SOLML.md?raw";
import sss from "../../../spec/SSS.md?raw";
import ir from "../../../spec/IR.md?raw";
import program from "../../../spec/PROGRAM.md?raw";
import receipts from "../../../spec/RECEIPTS.md?raw";

export const DOCS: { slug: string; title: string; file: string; md: string }[] = [
  { slug: "language", title: "Language", file: "SOLML.md", md: solml },
  { slug: "style-sheets", title: "Style sheets", file: "SSS.md", md: sss },
  { slug: "ir", title: "IR and terms", file: "IR.md", md: ir },
  { slug: "program", title: "Program", file: "PROGRAM.md", md: program },
  { slug: "receipts", title: "Receipts", file: "RECEIPTS.md", md: receipts },
];
