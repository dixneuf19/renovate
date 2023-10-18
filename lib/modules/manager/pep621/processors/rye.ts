import is from '@sindresorhus/is';
import { TEMPORARY_ERROR } from '../../../../constants/error-messages';
import { logger } from '../../../../logger';
import { exec } from '../../../../util/exec';
import type { ExecOptions, ToolConstraint } from '../../../../util/exec/types';
import { getSiblingFileName, readLocalFile } from '../../../../util/fs';
import { PypiDatasource } from '../../../datasource/pypi';
import type {
  PackageDependency,
  UpdateArtifact,
  UpdateArtifactsResult,
  Upgrade,
} from '../../types';
import type { PyProject } from '../schema';
import { depTypes, parseDependencyList } from '../utils';
import type { PyProjectProcessor } from './types';

const ryeUpdateLockCMD = 'rye lock';
const ryeUpdatePackageCMD = 'rye lock --update';

export class RyeProcessor implements PyProjectProcessor {
  process(project: PyProject, deps: PackageDependency[]): PackageDependency[] {
    const rye = project.tool?.rye;
    if (is.nullOrUndefined(rye)) {
      return deps;
    }
    logger.info('HERE \n processing rye');
    logger.debug({ rye });
    deps.push(
      ...parseDependencyList(
        depTypes.ryeDevDependencies,
        rye?.['dev-dependencies']
      )
    );

    const ryeSources = rye.sources;
    if (is.nullOrUndefined(ryeSources)) {
      logger.debug('no rye sources found');
      return deps;
    }

    const containsPyPiUrl = ryeSources.some((value) => value.name === 'pypi');
    const registryUrls: string[] = [];
    if (!containsPyPiUrl) {
      registryUrls.push(PypiDatasource.defaultURL);
    }
    for (const source of ryeSources) {
      registryUrls.push(source.url);
    }
    for (const dep of deps) {
      dep.registryUrls = registryUrls;
    }
    logger.debug('end of rye processor');
    logger.debug({ deps });
    return deps;
  }

  async updateArtifacts(
    updateArtifact: UpdateArtifact,
    project: PyProject
  ): Promise<UpdateArtifactsResult[] | null> {
    const { config, updatedDeps, packageFileName } = updateArtifact;

    const isLockFileMaintenance = config.updateType === 'lockFileMaintenance';

    const lockFileName = getSiblingFileName(
      packageFileName,
      'requirements.lock'
    );
    const devLockFileName = getSiblingFileName(
      packageFileName,
      'requirements-dev.lock'
    );
    try {
      const existingLockFileContent = await readLocalFile(lockFileName, 'utf8');
      const existingDevLockFileContent = await readLocalFile(
        devLockFileName,
        'utf8'
      );

      if (is.nullOrUndefined(existingLockFileContent)) {
        logger.debug('No requirements.lock found');
      }
      if (is.nullOrUndefined(existingDevLockFileContent)) {
        logger.debug('No requirements-dev.lock found');
      }

      // abort if no lockfile is defined
      // TODO: we could continue ?
      if (
        is.nullOrUndefined(existingLockFileContent) &&
        is.nullOrUndefined(existingDevLockFileContent)
      ) {
        return null;
      }

      const pythonConstraint: ToolConstraint = {
        toolName: 'python',
        constraint:
          config.constraints?.python ?? project.project?.['requires-python'],
      };
      const ryeConstraint: ToolConstraint = {
        toolName: 'rye',
        constraint: config.constraints?.rye,
      };

      const execOptions: ExecOptions = {
        cwdFile: packageFileName,
        docker: {},
        toolConstraints: [pythonConstraint, ryeConstraint],
      };

      // on lockFileMaintenance do not specify any packages and update the complete lock file
      // else only update specific packages
      const cmds: string[] = [];
      if (isLockFileMaintenance) {
        cmds.push(ryeUpdateLockCMD);
      } else {
        cmds.push(...generateCMDs(updatedDeps));
      }
      await exec(cmds, execOptions);

      const fileChanges: UpdateArtifactsResult[] = [];
      // check for changes for prod lock
      const newLockContent = await readLocalFile(lockFileName, 'utf8');
      const isLockFileChanged = existingLockFileContent !== newLockContent;
      if (isLockFileChanged) {
        fileChanges.push({
          file: {
            type: 'addition',
            path: lockFileName,
            contents: newLockContent,
          },
        });
      } else {
        logger.debug('requirements.lock is unchanged');
      }

      // check for changes for prod lock
      const newDevLockContent = await readLocalFile(devLockFileName, 'utf8');
      const isDevLockFileChanged =
        existingDevLockFileContent !== newDevLockContent;
      if (isDevLockFileChanged) {
        fileChanges.push({
          file: {
            type: 'addition',
            path: devLockFileName,
            contents: newDevLockContent,
          },
        });
      } else {
        logger.debug('requirements-dev.lock is unchanged');
      }

      return fileChanges.length ? fileChanges : null;
    } catch (err) {
      // istanbul ignore if
      if (err.message === TEMPORARY_ERROR) {
        throw err;
      }
      logger.debug({ err }, 'Failed to update rye lock files');
      return [
        {
          artifactError: {
            lockFile: lockFileName,
            stderr: err.message,
          },
        },
        {
          artifactError: {
            lockFile: devLockFileName,
            stderr: err.message,
          },
        },
      ];
    }
  }
}

function generateCMDs(updatedDeps: Upgrade[]): string[] {
  const cmds: string[] = [];
  const packagesByCMD: Record<string, string[]> = {};
  for (const dep of updatedDeps) {
    switch (dep.depType) {
      case depTypes.ryeDevDependencies: {
        const [_, name] = dep.depName!.split('/');
        addPackageToCMDRecord(packagesByCMD, ryeUpdatePackageCMD, name);
        break;
      }
      default: {
        addPackageToCMDRecord(
          packagesByCMD,
          ryeUpdatePackageCMD,
          dep.packageName!
        );
      }
    }
  }

  for (const commandPrefix in packagesByCMD) {
    const packageList = packagesByCMD[commandPrefix].join(' ');
    const cmd = `${commandPrefix} ${packageList}`;
    cmds.push(cmd);
  }

  return cmds;
}

function addPackageToCMDRecord(
  packagesByCMD: Record<string, string[]>,
  commandPrefix: string,
  packageName: string
): void {
  if (is.nullOrUndefined(packagesByCMD[commandPrefix])) {
    packagesByCMD[commandPrefix] = [];
  }
  packagesByCMD[commandPrefix].push(packageName);
}
