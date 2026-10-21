import { isTemplateAddress } from '../../../../workspace/public.js';
import type { FraudFacts, Signal } from './facts.js';
import { block, flag } from './signal.js';

export const RULE_CODE = 'AF-02';

/**
 * AF-02: the release address is not a template one (example.*, localhost) and is not held by another credited
 * project: a block. A stub page ("coming soon") is a flag; a stub on a blocked address gives the single block.
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const { url, heldByCreditedProject, placeholderPage } = facts.release;
  const templateAddress = isTemplateAddress(url);
  const data = { templateAddress, heldByCreditedProject, placeholderPage };
  if (templateAddress || heldByCreditedProject) return [block(RULE_CODE, data)];
  if (placeholderPage) return [flag(RULE_CODE, data)];
  return [];
}
