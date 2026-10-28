// How two spellings of one phone model are told apart, shared by repair's phone catalog and the
// parts that fit a model: letters and digits only, lower case ("Samsung" "A-55" = "samsunga55").
import { normalizeText } from '@bolusi/core';

export function compactModel(...parts: readonly string[]): string {
  return normalizeText(parts.join(' ')).replace(/ /g, '');
}
