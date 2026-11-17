/**
 * A TypeDoc plugin (loaded by typedoc.json) that puts the language package's generated declarations in a category.
 *
 * Everything else is categorised by an `@category` tag in its doc comment, and a re-export is listed under the category of what it
 * re-exports (the runtime re-exports the revision types of `@typedblite/content-revision`). The generated files (`libs/language/src/generated/`)
 * are rewritten whole by `langium generate`, so a tag cannot live there; their category is decided here, by file. Without it
 * the syntax tree's 436 declarations would be listed under "Other", beside the language services.
 */
import { Comment, CommentTag, Converter, ReflectionKind } from 'typedoc';

const CATEGORY_OF_FILE = [
  [/(^|\/)generated\/ast\.ts$/, 'Syntax tree'],
  [/(^|\/)generated\/(module|grammar)\.ts$/, 'Setup'],
];

/** The `@category` a declaration's comment names. A function's comment is its signature's. */
function categoryTag(reflection) {
  const comment = reflection.comment ?? reflection.signatures?.[0]?.comment;
  return comment?.getTag('@category')?.content.map((part) => part.text).join('').trim();
}

/** @param {import('typedoc').Application} app */
export function load(app) {
  // Before TypeDoc reads the tags (it does so while resolving), once every declaration exists.
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const reflection of Object.values(context.project.reflections)) {
      // Only an export of a module: a member of a class or an interface is listed under its owner, not in a category of its own.
      if (!reflection.isDeclaration() || !reflection.parent?.kindOf(ReflectionKind.SomeModule)) continue;
      const file = reflection.sources?.[0]?.fileName;
      const category = reflection.kindOf(ReflectionKind.Reference)
        ? categoryTag(reflection.tryGetTargetReflectionDeep() ?? reflection)
        : file && CATEGORY_OF_FILE.find(([pattern]) => pattern.test(file))?.[1];
      if (!category) continue;
      // A function's comment is its signature's: an empty one on the function itself would hide that one.
      const owner = reflection.signatures?.[0] ?? reflection;
      owner.comment ??= new Comment();
      if (!owner.comment.getTag('@category')) {
        owner.comment.blockTags.push(new CommentTag('@category', [{ kind: 'text', text: category }]));
      }
    }
  });
}
