import { Inject, Injectable } from '@nestjs/common';
import { PLAYBOOKS_API, type PlaybooksApi } from '../../../playbooks/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { RELEASE_KEY_PREFIX } from '../domain/completion-rules.js';

/** The check of the release when the scenario names none. */
const DEFAULT_RELEASE_KEY = `${RELEASE_KEY_PREFIX}_web`;

/** Which `release_alive_*` check the release step of a team asks for (FR-WORK-14): the scenario decides. */
@Injectable()
export class ReleaseTargetService {
  constructor(
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(PLAYBOOKS_API) private readonly playbooks: PlaybooksApi,
  ) {}

  async checkKeyOf(teamId: string, stepKey: string): Promise<string> {
    const team = await this.teams.getTeamView(teamId);
    if (team === null) return DEFAULT_RELEASE_KEY;
    const definition = await this.playbooks.getDefinition(team.playbookId);
    const step = definition.stages.flatMap((s) => s.steps).find((s) => s.key === stepKey);
    return (
      step?.autoChecks.find((key) => key.startsWith(RELEASE_KEY_PREFIX)) ?? DEFAULT_RELEASE_KEY
    );
  }
}
