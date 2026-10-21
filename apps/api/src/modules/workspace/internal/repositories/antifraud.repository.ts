import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { artifactFile } from '../schema/artifact.js';
import { releaseCheck } from '../schema/release.js';
import { projectStage } from '../schema/stage.js';

export interface StageTimes {
  ordinal: number;
  plannedDays: number;
  openedAt: Date | null;
  closedAt: Date | null;
}

export interface ArtifactRow {
  name: string;
  sizeBytes: number;
  sha256: string;
}

/** The reads of the anti-fraud rules that no other repository of workspace makes (S7-03). */
@Injectable()
export class AntifraudRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async stages(teamId: string): Promise<StageTimes[]> {
    const rows = await this.tx.tx
      .select({
        ordinal: projectStage.ordinal,
        plannedDays: projectStage.durationDays,
        openedAt: projectStage.openedAt,
        closedAt: projectStage.closedAt,
      })
      .from(projectStage)
      .where(eq(projectStage.teamId, teamId))
      .orderBy(asc(projectStage.ordinal));
    return rows;
  }

  /** The files that still exist (a deleted one is not a file of the project any more). */
  async artifacts(teamId: string): Promise<ArtifactRow[]> {
    const rows = await this.tx.tx
      .select({
        name: artifactFile.originalName,
        sizeBytes: artifactFile.sizeBytes,
        sha256: artifactFile.sha256,
      })
      .from(artifactFile)
      .where(and(eq(artifactFile.teamId, teamId), isNull(artifactFile.deletedAt)))
      .orderBy(asc(artifactFile.createdAt), asc(artifactFile.id));
    return rows.map((r) => ({ ...r, sha256: r.sha256.toString('hex') }));
  }

  /** Teams other than `exceptTeamId` that hold a file with one of the hashes (hex), by `artifact_file_sha_idx`. */
  async teamsWithHashes(hashes: string[], exceptTeamId: string): Promise<string[]> {
    if (hashes.length === 0) return [];
    const rows = await this.tx.tx
      .selectDistinct({ teamId: artifactFile.teamId })
      .from(artifactFile)
      .where(
        and(
          inArray(
            artifactFile.sha256,
            hashes.map((h) => Buffer.from(h, 'hex')),
          ),
          ne(artifactFile.teamId, exceptTeamId),
          isNull(artifactFile.deletedAt),
        ),
      );
    return rows.map((r) => r.teamId);
  }

  /** Hashes (hex) of the files of the team that another team holds too. */
  async sharedHashes(teamId: string, hashes: string[]): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();
    const rows = await this.tx.tx
      .selectDistinct({ sha256: artifactFile.sha256 })
      .from(artifactFile)
      .where(
        and(
          inArray(
            artifactFile.sha256,
            hashes.map((h) => Buffer.from(h, 'hex')),
          ),
          ne(artifactFile.teamId, teamId),
          isNull(artifactFile.deletedAt),
        ),
      );
    return new Set(rows.map((r) => r.sha256.toString('hex')));
  }

  /** The newest look at the release address says "a stub page" (AF-02). */
  async releaseIsPlaceholder(teamId: string): Promise<boolean> {
    const [row] = await this.tx.tx
      .select({ reason: releaseCheck.reason })
      .from(releaseCheck)
      .where(eq(releaseCheck.teamId, teamId))
      .orderBy(desc(releaseCheck.checkedAt))
      .limit(1);
    return row?.reason === 'PLACEHOLDER_TITLE';
  }
}
