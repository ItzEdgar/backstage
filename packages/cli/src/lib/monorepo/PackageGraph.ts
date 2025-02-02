/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { relative as relativePath, posix as posixPath } from 'path';
import { getPackages, Package } from '@manypkg/get-packages';
import { paths } from '../paths';
import { PackageRole } from '../role';
import { listChangedFiles } from '../git';

type PackageJSON = Package['packageJson'];

export interface ExtendedPackageJSON extends PackageJSON {
  scripts?: {
    [key: string]: string;
  };
  // The `bundled` field is a field known within Backstage, it means
  // that the package bundles all of its dependencies in its build output.
  bundled?: boolean;

  backstage?: {
    role?: PackageRole;
  };
}

export type ExtendedPackage = {
  dir: string;
  packageJson: ExtendedPackageJSON;
};

export type PackageGraphNode = {
  /** The name of the package */
  name: string;
  /** The directory of the package */
  dir: string;
  /** The package data of the package itself */
  packageJson: ExtendedPackageJSON;
  /** All direct local dependencies of the package */
  allLocalDependencies: Map<string, PackageGraphNode>;
  /** All direct local dependencies that will be present in the published package */
  publishedLocalDependencies: Map<string, PackageGraphNode>;
  /** Local dependencies */
  localDependencies: Map<string, PackageGraphNode>;
  /** Local devDependencies */
  localDevDependencies: Map<string, PackageGraphNode>;
  /** Local optionalDependencies */
  localOptionalDependencies: Map<string, PackageGraphNode>;
};

export class PackageGraph extends Map<string, PackageGraphNode> {
  static async listTargetPackages(): Promise<ExtendedPackage[]> {
    const { packages } = await getPackages(paths.targetDir);
    return packages as ExtendedPackage[];
  }

  static fromPackages(packages: Package[]): PackageGraph {
    const graph = new PackageGraph();

    // Add all local packages to the graph
    for (const pkg of packages) {
      const name = pkg.packageJson.name;
      const existingPkg = graph.get(name);
      if (existingPkg) {
        throw new Error(
          `Duplicate package name '${name}' at ${pkg.dir} and ${existingPkg.dir}`,
        );
      }

      graph.set(name, {
        name,
        dir: pkg.dir,
        packageJson: pkg.packageJson as ExtendedPackageJSON,
        allLocalDependencies: new Map(),
        publishedLocalDependencies: new Map(),
        localDependencies: new Map(),
        localDevDependencies: new Map(),
        localOptionalDependencies: new Map(),
      });
    }

    // Populate the local dependency structure
    for (const node of graph.values()) {
      for (const depName of Object.keys(node.packageJson.dependencies || {})) {
        const depPkg = graph.get(depName);
        if (depPkg) {
          node.allLocalDependencies.set(depName, depPkg);
          node.publishedLocalDependencies.set(depName, depPkg);
          node.localDependencies.set(depName, depPkg);
        }
      }
      for (const depName of Object.keys(
        node.packageJson.devDependencies || {},
      )) {
        const depPkg = graph.get(depName);
        if (depPkg) {
          node.allLocalDependencies.set(depName, depPkg);
          node.localDevDependencies.set(depName, depPkg);
        }
      }
      for (const depName of Object.keys(
        node.packageJson.optionalDependencies || {},
      )) {
        const depPkg = graph.get(depName);
        if (depPkg) {
          node.allLocalDependencies.set(depName, depPkg);
          node.publishedLocalDependencies.set(depName, depPkg);
          node.localOptionalDependencies.set(depName, depPkg);
        }
      }
    }

    return graph;
  }

  /**
   * Traverses the package graph and collects a set of package names.
   *
   * The traversal starts at the provided list names, and continues
   * throughout all the names returned by the `collectFn`, which is
   * called once for each seen package.
   */
  collectPackageNames(
    startingPackageNames: string[],
    collectFn: (pkg: PackageGraphNode) => Iterable<string> | undefined,
  ): Set<string> {
    const targets = new Set<string>();
    const searchNames = startingPackageNames.slice();

    while (searchNames.length) {
      const name = searchNames.pop()!;

      if (targets.has(name)) {
        continue;
      }

      const node = this.get(name);
      if (!node) {
        throw new Error(`Package '${name}' not found`);
      }

      targets.add(name);

      const collected = collectFn(node);
      if (collected) {
        searchNames.push(...collected);
      }
    }

    return targets;
  }

  async listChangedPackages(options: { ref: string }) {
    const changedFiles = await listChangedFiles(options.ref);

    const dirMap = new Map(
      Array.from(this.values()).map(pkg => [
        posixPath.normalize(relativePath(paths.targetRoot, pkg.dir)) +
          posixPath.sep,
        pkg,
      ]),
    );
    const packageDirs = Array.from(dirMap.keys());

    const result = new Array<PackageGraphNode>();
    let searchIndex = 0;

    changedFiles.sort();
    packageDirs.sort();

    for (const packageDir of packageDirs) {
      // Skip through changes that appear before our package dir
      while (
        searchIndex < changedFiles.length &&
        changedFiles[searchIndex] < packageDir
      ) {
        searchIndex += 1;
      }

      // Check if we arrived at a match, otherwise we move on to the next package dir
      if (changedFiles[searchIndex]?.startsWith(packageDir)) {
        searchIndex += 1;

        result.push(dirMap.get(packageDir)!);

        // Skip through the rest of the changed files for the same package
        while (changedFiles[searchIndex]?.startsWith(packageDir)) {
          searchIndex += 1;
        }
      }
    }

    return result;
  }
}
