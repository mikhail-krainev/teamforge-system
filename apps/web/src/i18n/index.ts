import { ruDictionaries } from './registry.generated';
import { createTranslator, flatten, type MessageTree } from './translator';

type Flatten<T, P extends string = ''> = T extends string
  ? P
  : { [K in keyof T & string]: Flatten<T[K], P extends '' ? K : `${P}.${K}`> }[keyof T & string];

/** Every key of every dictionary file in `src/i18n/ru`, as `<file>.<path>`. */
export type MessageKey = Flatten<typeof ruDictionaries>;

const translator = createTranslator<MessageKey>(
  flatten(ruDictionaries as MessageTree) as Record<MessageKey, string>,
  'ru',
);

export const t = translator.t;
export const hasMessage = translator.has;
export type { MessageParams } from './translator';
