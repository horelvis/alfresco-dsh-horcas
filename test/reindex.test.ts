import { describe, expect, it } from 'vitest';
import {
  isSearchCommunity,
  minCommitTimeSql,
  missingPrefixes,
  parseModelNamespaces,
  parseTotalIndexed,
  prefixesFromModels,
  prefixesJson,
  reindexingAppCommand,
  resolveReindexStrategy,
  searchCommunityReindexScript,
  verifyIndexed,
  watermarkSeedBody,
  WATERMARK_DOC_ID,
} from '../src/domain/reindex.js';

describe('reindex strategy', () => {
  it('Solr 5.x -> delete; 6/7.x -> tracking', () => {
    expect(resolveReindexStrategy('SOLR', '5.2.0', '7.4').kind).toBe('SOLR_DELETE');
    expect(resolveReindexStrategy('SOLR', '6.6.0', '7.4').kind).toBe('SOLR_TRACKING');
  });

  it('Search Enterprise (EE) -> Reindexing app online con el jar de la version destino', () => {
    const strategy = resolveReindexStrategy('OPENSEARCH', '7.1.0', '26.2', 'EE');
    expect(strategy.kind).toBe('REINDEXING_APP');
    expect(strategy.tool).toBe('alfresco-elasticsearch-reindexing-26.2-app.jar');
    expect(strategy.online).toBe(true);
  });

  it('Search Community (CE 26.2+) -> batch indexer por watermark', () => {
    const strategy = resolveReindexStrategy('OPENSEARCH', '7.1.0', '26.2', 'CE');
    expect(strategy.kind).toBe('SEARCH_COMMUNITY');
    expect(strategy.tool).toContain('alfresco-elasticsearch-batch-indexing');
  });

  it('Search Community solo aplica a CE 26.2+', () => {
    expect(isSearchCommunity('26.2', 'CE', 'OPENSEARCH')).toBe(true);
    expect(isSearchCommunity('26.2', 'EE', 'OPENSEARCH')).toBe(false);
    expect(isSearchCommunity('25.3', 'CE', 'OPENSEARCH')).toBe(false);
    expect(isSearchCommunity('26.2', 'CE', 'SOLR')).toBe(false);
  });
});

describe('watermark del batch indexer (Search Community)', () => {
  it('siembra el cursor en min(commit_time_ms) del alf_transaction', () => {
    expect(minCommitTimeSql()).toContain('min(commit_time_ms)');
    expect(minCommitTimeSql()).toContain('alf_transaction');
    expect(watermarkSeedBody(1262304000000)).toBe('{"schemaVersion":1,"lastSuccessfulToTimeEpochMs":1262304000000}');
  });

  it('el script pone el cursor en el indice de estado y lo lee de vuelta', () => {
    const script = searchCommunityReindexScript({ project: 'gadex-710', dbUser: 'alfresco', dbName: 'alfresco' });
    expect(script).toContain(`_doc/${WATERMARK_DOC_ID}`);
    expect(script).toContain('alfresco-reindex-state');
    expect(script).toContain('min(commit_time_ms)');
    expect(script).toContain("grep -Ei 'opensearch|elasticsearch'");
  });

  it('descubre el motor por servicio compose y NUNCA elige el batch indexer (su imagen contiene "elasticsearch")', () => {
    const script = searchCommunityReindexScript({ project: 'gadex-710', dbUser: 'alfresco', dbName: 'alfresco' });
    expect(script).toContain("label=com.docker.compose.service=search");
    expect(script).toContain("label=com.docker.compose.service=postgres");
    expect(script).toContain("grep -Eiv 'batch-index'");
  });

  it('con URL del motor usa curl desde el host; con contenedor, dentro del contenedor', () => {
    const host = searchCommunityReindexScript({ dbUser: 'alfresco', dbName: 'alfresco', searchUrl: 'http://es:9200/' });
    expect(host).toContain('CURL="curl -fsS"');
    expect(host).toContain('BASE=\'http://es:9200\'');
    const container = searchCommunityReindexScript({ dbUser: 'alfresco', dbName: 'alfresco', searchContainer: 'gadex-search-1' });
    expect(container).toContain('CURL="docker exec $SEARCH curl -fsS"');
    expect(container).toContain("SEARCH='gadex-search-1'");
  });
});

describe('prefix-map del indexador (namespaces propios)', () => {
  it('deriva uri->prefix de los modelos y detecta los que faltan o difieren', () => {
    const models = [{ namespaces: [{ uri: 'http://acme/gadex', prefix: 'gadex' }, { uri: 'http://acme/ocr', prefix: 'ocr' }] }];
    const required = prefixesFromModels(models);
    expect(required).toEqual([{ uri: 'http://acme/gadex', prefix: 'gadex' }, { uri: 'http://acme/ocr', prefix: 'ocr' }]);
    expect(missingPrefixes(required, [{ uri: 'http://acme/gadex', prefix: 'gadex' }])).toEqual([{ uri: 'http://acme/ocr', prefix: 'ocr' }]);
    expect(missingPrefixes(required, [{ uri: 'http://acme/gadex', prefix: 'GADEX' }])).toHaveLength(2);
    expect(missingPrefixes(required, required)).toEqual([]);
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
  const strategy = resolveReindexStrategy('OPENSEARCH', '7.1.0', '26.2', 'EE');
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
