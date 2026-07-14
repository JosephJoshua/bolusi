// Stub for root scripts whose real implementation belongs to a later task.
// MUST exit non-zero so nothing reads a stub as green (task 01 acceptance; CLAUDE.md §2.1).
const [, , script, task] = process.argv;
console.error(`${script ?? 'script'}: not implemented — see task ${task ?? '??'} (ai-docs/tasks/)`);
process.exit(1);
