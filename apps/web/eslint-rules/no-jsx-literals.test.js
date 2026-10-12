import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import { noJsxLiterals } from './no-jsx-literals.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
});

tester.run('no-jsx-literals', noJsxLiterals, {
  valid: [
    { code: 'const a = <p>{t("status.ok")}</p>;' },
    { code: 'const a = <p>{value}</p>;' },
    { code: 'const a = <p>{"/"}</p>;' },
    { code: 'const a = <span> / </span>;' },
    { code: 'const a = <a href="/x" aria-label={t("k")} className="card" />;' },
    { code: 'const a = <p>{`${count}`}</p>;' },
  ],
  invalid: [
    { code: 'const a = <p>Hello</p>;', errors: [{ messageId: 'text' }] },
    { code: 'const a = <p>Привет, мир</p>;', errors: [{ messageId: 'text' }] },
    { code: 'const a = <p>{"Hello"}</p>;', errors: [{ messageId: 'expression' }] },
    { code: 'const a = <p>{`Hello`}</p>;', errors: [{ messageId: 'expression' }] },
    { code: 'const a = <button aria-label="Close" />;', errors: [{ messageId: 'attribute' }] },
    { code: 'const a = <img alt={"Logo"} />;', errors: [{ messageId: 'attribute' }] },
    { code: 'const a = <input placeholder="Имя" />;', errors: [{ messageId: 'attribute' }] },
  ],
});
