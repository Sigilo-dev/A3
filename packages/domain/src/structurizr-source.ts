import type { ExtensionMap } from './models.js';

export const STRUCTURIZR_DSL_SOURCE_TYPE = 'a3.diagram.structurizr-dsl';
export const STRUCTURIZR_JSON_SOURCE_TYPE = 'a3.diagram.structurizr-json';
export const STRUCTURIZR_SOURCE_LIMIT = 1024 * 1024;

export type StructurizrSourceFormat = 'structurizr-dsl' | 'structurizr-json';

export function structurizrSourceProperties(format: StructurizrSourceFormat): ExtensionMap {
  return {
    'a3.diagram.authority': 'source',
    'a3.diagram.format': format,
    'a3.diagram.renderer': 'a3-c4-static@1.0.0'
  };
}

export function isStructurizrSource(type: string): type is typeof STRUCTURIZR_DSL_SOURCE_TYPE | typeof STRUCTURIZR_JSON_SOURCE_TYPE {
  return type === STRUCTURIZR_DSL_SOURCE_TYPE || type === STRUCTURIZR_JSON_SOURCE_TYPE;
}

export function structurizrSourceFormat(type: string, extension: string): StructurizrSourceFormat | undefined {
  if (type === STRUCTURIZR_DSL_SOURCE_TYPE && extension.toLowerCase() === '.dsl') return 'structurizr-dsl';
  if (type === STRUCTURIZR_JSON_SOURCE_TYPE && extension.toLowerCase() === '.json') return 'structurizr-json';
  return undefined;
}
