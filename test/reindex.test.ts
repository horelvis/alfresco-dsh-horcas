import { describe, expect, it } from 'vitest';
import {
  parseModelNamespaces,
  parseTotalIndexed,
  prefixesJson,
  reindexingAppCommand,
  resolveReindexStrategy,
  verifyIndexed,
} from '../src/domain/reindex.js';

describe('reindex strategy', () => {
  it('Solr 5.x -> delete; 6/7.x -> tracking', () => {
    expect(resolveReindexStrategy('SOLR', '5.2.0', '7.4').kind).toBe('SOLR_DELETE');
    expect(resolveReindexStrategy('SOLR', '6.6.0', '7.4').kind).toBe('SOLR_TRACKING');
  });

  it('Search Enterprise -> Reindexing app online con el jar de la version destino', () => {
    const strategy = resolveReindexStrategy('OPENSEARCH', '7.1.0', '26.2');
    expect(strategy.kind).toBe('REINDEXING_APP');
    expect(strategy.tool).toBe('alfresco-elasticsearch-reindexing-26.2-app.jar');
    expect(strategy.online).toBe(true);
  });
});

describe('prefixes-file', () => {
  it('parsea namespaces de un modelo XML', () => {
    const xml = `<?xml version="1.0"?>
      <model name="wys" xmlns="http://www.alfresco.org/model/dictionary/1.0">
        <namespaces>
          <namespace uri="http://www.acme.org/model/wys/1.0" prefix="wys"/>
          <namespace uri="http://www.alfresco.org/model/content/1.0" prefix="cm"/>
        </namespaces>
      </model>`;
    const namespaces = parseModelNamespaces(xml);
    expect(namespaces).toContainEqual({ uri: 'http://www.acme.org/model/wys/1.0', prefix: 'wys' });
    expect(namespaces).toContainEqual({ uri: 'http://www.alfresco.org/model/content/1.0', prefix: 'cm' });
  });

  it('genera JSON ordenado por uri', () => {
    const json = prefixesJson([
      { uri: 'http://z', prefix: 'z' },
      { uri: 'http://a', prefix: 'a' },
    ]);
    expect(json.indexOf('http://a')).toBeLessThan(json.indexOf('http://z'));
  });
});

describe('reindexing app', () => {
  const strategy = resolveReindexStrategy('OPENSEARCH', '7.1.0', '26.2');
  const params = {
    databaseUrl: 'jdbc:postgresql://db:5432/alfresco',
    databaseUser: 'alfresco',
    searchUrl: 'http://search:9200',
    brokerUrl: 'tcp://activemq:61616',
    prefixesFile: '/tmp/reindex.prefixes-file.json',
    repositoryUrl: 'http://alfresco:8080/alfresco',
  };

  it('construye el comando con todas las propiedades', () => {
    const command = reindexingAppCommand(strategy, params);
    expect(command).toContain('-jar');
    expect(command.join(' ')).toContain('--alfresco.reindex.prefixes-file=/tmp/reindex.prefixes-file.json');
    expect(command.join(' ')).toContain('--spring.elasticsearch.rest.uris=http://search:9200');
  });

  it('parsea Total indexed documents y verifica', () => {
    expect(parseTotalIndexed('... Total indexed documents:: 5760 ...')).toBe(5760);
    expect(parseTotalIndexed('sin resumen')).toBe(-1);
    expect(verifyIndexed('Total indexed documents:: 5760', 5760)).toBe(true);
    expect(verifyIndexed('Total indexed documents:: 5000', 5760)).toBe(false);
  });

  it('rechaza el comando para estrategias no-ReindexingApp', () => {
    expect(() => reindexingAppCommand(resolveReindexStrategy('SOLR', '6.6', '7.4'), params)).toThrow();
  });
});
