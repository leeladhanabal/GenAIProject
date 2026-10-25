import { Scenario, Specification } from './planning-content';

export const AI_PLANNING_ADAPTER = Symbol('AI_PLANNING_ADAPTER');

export interface AiPlanningAdapter {
  // Implementations receive only the selected immutable version, never user
  // tokens or target credentials. Provider output remains untrusted data.
  generate(input: {
    requirementsText: string;
    specification: Specification | null;
  }): Promise<{ scenarios: Scenario[] }>;
}

