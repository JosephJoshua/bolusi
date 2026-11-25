// A comment says what is true now. A note that defers the real fix (the markers below) is copied by
// the next change as permission to patch around the problem, and it goes stale the day the gap
// closes. Fix the problem, or put the gap where the person who decides it will see it.
const EXCUSES = [
  /\b(?:TODO|FIXME|HACK)\b/,
  /\bKNOWN GAP\b/i,
  /\bNOT YET IMPLEMENTED\b/i,
  /\bfor now\b/i,
  /\bwork-?arounds?\b/i,
  /\btemporar(?:y|ily)\b/i,
  /\buntil task \d+/i,
];

export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Comments state what is true now, never a deferred fix.' },
    schema: [],
    messages: {
      excuse:
        "'{{word}}' marks a deferred fix. Fix it now, or tell the owner about the gap; a comment like this gets copied and goes stale. Describe only what the code does today.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          for (const pattern of EXCUSES) {
            const match = pattern.exec(comment.value);
            if (match) {
              context.report({ loc: comment.loc, messageId: 'excuse', data: { word: match[0] } });
              break;
            }
          }
        }
      },
    };
  },
};
