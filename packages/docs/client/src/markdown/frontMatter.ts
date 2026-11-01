// Front matter (a YAML block between `---` lines at the top of the file) is shown as-is in the preview rather
// than as a heading: remark-frontmatter parses it into a `yaml` node, which this plugin turns into a code
// block holding the original text, fences included.
interface Node {
  type: string;
  value?: string;
  lang?: string | null;
  children?: Node[];
}

export function frontMatterAsCode() {
  return (tree: Node) => {
    const first = tree.children?.[0];
    if (first && first.type === 'yaml') {
      first.type = 'code';
      first.lang = 'yaml';
      first.value = `---\n${first.value ?? ''}\n---`;
    }
  };
}
