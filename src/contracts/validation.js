import fs from 'fs';
import path from 'path';

import { VError } from 'verror';
import _ from 'lodash';

import ProjectRevisionRepository from '../projects/repositories/project_revision';
import Contract from './contract';
import { Project } from '../projects/models';
import Definitions from './definitions';
import Integrations from './integrations';

function extraSchemaValidation(def) {
  //todo: remove this limitation, find a way to allow projects to define multiple integration points with the same type
  //      an option might be giving a unique key for each promise that consumers can use
  if (
    _.has(def, 'contracts.promises') &&
    !_.isEmpty(
      _.chain(def.contracts.promises)
        .countBy(promise => promise.integration)
        .filter(g => g > 1)
        .value()
    )
  ) {
    throw new VError('You can have a maximum of one producer promise for each integration type.');
  }

  return def;
}

async function contractsPathsValidation(def, dirBasePath) {
  if (!('contracts' in def)) {
    return;
  }

  let dirs = [];

  if ('promises' in def.contracts) {
    dirs = _.concat(dirs, _.map(def.contracts.promises, 'dir'));
  }

  if ('expectations' in def.contracts) {
    dirs = _.concat(dirs, _.map(def.contracts.expectations, 'dir'));
  }

  return Promise.all(
    dirs.map(async dir => {
      const fullPath = path.join(dirBasePath, dir);

      await new Promise((resolve, reject) => {
        fs.access(fullPath, fs.constants.R_OK | fs.constants.R_OK, err => {
          if (err) {
            reject(new VError(`'${dir}' doesn't exist in your contracts directory`));
          } else {
            resolve();
          }
        });
      });
    })
  );
}

async function contractsSchemaValidation(projectRevision) {
  return Promise.all(
    projectRevision.contracts.map(async c => {
      const facade = Integrations.get(c.integrationType);
      return await facade.validateContractSchema(projectRevision, c).catch(err => {
        throw new VError(
          `Error! contract at ${projectRevision.project().repo}:` +
            `${projectRevision.project().dir}/${c.dir} of type ${c.integrationType} is not valid ` +
            err.message
        );
      });
    })
  );
}

async function producerPromisesValidation(projectRevision, def) {
  if (!('promises' in def.contracts) || def.contracts.promises.length === 0) {
    return;
  }

  const consumerProjectsRevs = await ProjectRevisionRepository.consumersOf(projectRevision);
  const promises = projectRevision.contracts.filter(c => c.type === Contract.Types.PROMISE);

  return await Promise.all(
    promises.map(async promise => {
      return Promise.all(
        consumerProjectsRevs
          .map(consumerProjectRev => {
            const consumerExpectation = consumerProjectRev.contracts
              .filter(c => c.type === Contract.Types.EXPECTATION)
              .find(
                c =>
                  c.integrationType === promise.integrationType &&
                  c.upstream.repo === projectRevision.project().repo &&
                  c.upstream.dir === projectRevision.project().dir
              );

            if (consumerExpectation) {
              return {
                consumerProjectRev,
                consumerExpectation
              };
            }

            return null;
          })
          .filter(pair => pair !== null)
          .map(async pair => {
            const facade = Integrations.get(promise.integrationType);

            return await facade
              .validate(projectRevision, pair.consumerProjectRev, promise, pair.consumerExpectation)
              .catch(err => {
                throw new VError(
                  `Consumer [ ${pair.consumerProjectRev.project()
                    .repo}:${pair.consumerProjectRev.project()
                    .dir}/ @ ${pair.consumerProjectRev.rev()} ] ` +
                    `expectations of type (${pair.consumerExpectation
                      .integrationType}) is broken: \n` +
                    `============================================================================ \n` +
                    err.message
                );
              });
          })
      );
    })
  );
}

async function consumerExpectationsValidation(projectRevision, def) {
  if (!('expectations' in def.contracts) || def.contracts.expectations.length === 0) {
    return;
  }

  const expectations = projectRevision.contracts.filter(c => c.type === Contract.Types.EXPECTATION);

  return Promise.all(
    expectations.map(async e => {
      e.upstream.dir = _.defaultTo(e.upstream.dir, 'contracts');

      let rev = 'master';
      if (
        e.upstream.repo === projectRevision.project().repo &&
        e.upstream.dir === projectRevision.project().dir
      ) {
        rev = projectRevision.rev();
      }

      const upstream = await ProjectRevisionRepository.findByProjectAndRev(
        new Project({ repo: e.upstream.repo, dir: e.upstream.dir }),
        rev
      );
      const upstreamPromises = upstream.contracts.filter(c => c.type === Contract.Types.PROMISE);
      const upstreamPromise = upstreamPromises.find(p => p.integrationType === e.integrationType);

      const facade = Integrations.get(e.integrationType);

      return await facade.validate(upstream, projectRevision, upstreamPromise, e).catch(err => {
        throw new VError(
          `Producer [ ${upstream.project().repo}:${upstream.project()
            .dir}/ @ ${upstream.rev()} ] ` +
            `expectations of type (${e.integrationType}) is broken: \n` +
            `============================================================================ \n` +
            err.message
        );
      });
    })
  );
}

/**
 * Validates:
 *
 * 1. the contracts.yml and existence of directories.
 * 2. consumer expectations (consumer-producer cross-validation).
 * 3. producer promises (producer-consumer cross-validation).
 *
 * @param projectRevision
 *
 * @return Promise
 */
export default {
  isValid: async projectRevision => {
    const dirBasePath = projectRevision.workspace.getContractsPath();
    const def = await Definitions.load(projectRevision.workspace);

    await extraSchemaValidation(def);
    await contractsPathsValidation(def, dirBasePath);
    await contractsSchemaValidation(projectRevision, def);
    await producerPromisesValidation(projectRevision, def);
    await consumerExpectationsValidation(projectRevision, def);
  }
};
