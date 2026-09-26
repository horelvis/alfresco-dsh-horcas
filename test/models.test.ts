import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseModel, validateModelsJar } from '../src/domain/models.js';
import { renderCompose } from '../src/domain/provision.js';
import { runShell } from '../src/infra/exec.js';

const model = (name: string, prefix: string, uri: string, extra = '') => `<?xml version="1.0"?>
<model name="${name}" xmlns="http://www.alfresco.org/model/dictionary/1.0">
  <imports><import uri="http://www.alfresco.org/model/content/1.0" prefix="cm"/></imports>
  <namespaces><namespace uri="${uri}" prefix="${prefix}"/></namespaces>${extra}
</model>`;

async function jar(files: Record<string, string>): Promise<string> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mjar-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(tmp, 'src', name)), { recursive: true });
    await writeFile(path.join(tmp, 'src', name), content);
  }
  await runShell({ name: 'local' }, `cd "${tmp}/src" && zip -qr ../m.jar .`);
  return path.join(tmp, 'm.jar');
}

describe('JAR de modelos del instalador', () => {
  it('reconoce modelos de diccionario y restricciones con clase Java', () => {
    const m = parseModel(model('exp:model', 'exp', 'http://acme/exp', '<constraints><constraint name="exp:c" type="class"><parameter name="className"><value>com.acme.C</value></parameter></constraint></constraints>'), 'x.xml')!;
    expect(m.name).toBe('exp:model');
    expect(m.classConstraints).toEqual(['com.acme.C']);
    expect(parseModel('<beans/>', 'y.xml')).toBeUndefined();
  });

  it('valida un JAR con contexto en alfresco/extension y modelos', async () => {
    const ok = await validateModelsJar(await jar({
      'alfresco/extension/acme-models-context.xml': '<beans/>',
      'alfresco/extension/acme-models/exp.xml': model('exp:model', 'exp', 'http://acme/exp'),
    }));
    expect(ok.ok).toBe(true);
    expect(ok.models.map((m) => m.name)).toEqual(['exp:model']);
  });

  it('rechaza un JAR sin contexto (no se cargaria) o sin modelos', async () => {
    const noContext = await validateModelsJar(await jar({ 'models/exp.xml': model('exp:model', 'exp', 'http://acme/exp') }));
    expect(noContext.reason).toMatch(/sin contexto Spring/);
    const noModels = await validateModelsJar(await jar({ 'alfresco/extension/x-context.xml': '<beans/>' }));
    expect(noModels.reason).toMatch(/sin modelos/);
    expect((await validateModelsJar('/no/existe.jar')).ok).toBe(false);
  });

  it('el compose de cualquier hop monta el JAR de modelos en WEB-INF/lib', () => {
    const yaml = renderCompose({ projectName: 'p', acsVersion: '7.4', edition: 'CE', deployment: 'compose', database: { engine: 'postgresql' }, dataDir: '/d', modelsJar: '/d/models/acme-models.jar' });
    expect(yaml).toContain('- /d/models/acme-models.jar:/usr/local/tomcat/webapps/alfresco/WEB-INF/lib/acme-models.jar:ro');
  });
});

describe('cobertura de modelos frente al origen (bloqueo del primer hop)', () => {
  const inUse = [
    'http://www.alfresco.org/model/content/1.0', 'http://www.alfresco.org/model/system/1.0',
    'http://acme.example/expediente/1.0', 'http://acme.example/registro/1.0', 'http://www.fme.de/jsconsole/1.0',
  ];
  const jarModels = [parseModel(model('exp:model', 'exp', 'http://acme.example/expediente/1.0'), 'a')!, parseModel(model('reg:model', 'reg', 'http://acme.example/registro/1.0'), 'b')!];

  it('los namespaces estandar de Alfresco no requieren JAR', async () => {
    const { isStandardNamespace } = await import('../src/domain/models.js');
    expect(isStandardNamespace('http://www.alfresco.org/model/aos/1.0')).toBe(true);
    expect(isStandardNamespace('http://acme.example/expediente/1.0')).toBe(false);
  });

  it('sin JAR, todo namespace propio en uso bloquea', async () => {
    const { modelsCoverage } = await import('../src/domain/models.js');
    expect(modelsCoverage(inUse, []).missing).toEqual(['http://acme.example/expediente/1.0', 'http://acme.example/registro/1.0', 'http://www.fme.de/jsconsole/1.0']);
  });

  it('el JAR cubre lo suyo; lo declarado como no necesario se acepta y queda documentado', async () => {
    const { modelsCoverage } = await import('../src/domain/models.js');
    expect(modelsCoverage(inUse, jarModels).missing).toEqual(['http://www.fme.de/jsconsole/1.0']);
    const decided = modelsCoverage(inUse, jarModels, ['http://www.fme.de/jsconsole/1.0']);
    expect(decided.missing).toEqual([]);
    expect(decided.accepted).toEqual(['http://www.fme.de/jsconsole/1.0']);
    expect(modelsCoverage(['http://www.alfresco.org/model/content/1.0'], []).custom).toEqual([]);
  });
});

describe('JAR de modulo (SDK) como JAR de modelos', () => {
  const ctxXml = (extra = '') => `<beans><bean id="m.dictionaryBootstrap" parent="dictionaryModelBootstrap" depends-on="dictionaryBootstrap"/>${extra}</beans>`;

  it('acepta alfresco/module/<id>/module-context.xml con module.properties y avisa del contenido inesperado', async () => {
    const check = await validateModelsJar(await jar({
      'alfresco/module/acme-platform/module-context.xml': ctxXml(),
      'alfresco/module/acme-platform/module.properties': 'module.id=acme-platform',
      'alfresco/module/acme-platform/model/acme.xml': model('acme:model', 'acme', 'http://acme.example/1.0'),
      'alfresco/module/acme-platform/alfresco-global.properties': 'x=1',
      'docker/docker-compose.yml': 'services: {}',
      'rebel.xml': '<rebel/>',
    }));
    expect(check.ok).toBe(true);
    expect(check.moduleId).toBe('acme-platform');
    expect(check.warnings.join(' ')).toMatch(/alfresco-global\.properties/);
    expect(check.warnings.join(' ')).toMatch(/docker/);
    expect(check.warnings.join(' ')).toMatch(/rebel\.xml/);
    expect(check.warnings.join(' ')).toMatch(/mismo id/);
  });

  it('bloquea un modulo sin module.properties y un contexto con clases propias ausentes', async () => {
    const noProps = await validateModelsJar(await jar({
      'alfresco/module/m/module-context.xml': ctxXml(),
      'alfresco/module/m/model/a.xml': model('a:m', 'a', 'http://a'),
    }));
    expect(noProps.reason).toMatch(/sin module\.properties/);
    const missingClass = await validateModelsJar(await jar({
      'alfresco/module/m/module-context.xml': ctxXml('<bean id="x" class="com.example.acme.Behaviour"/><bean id="y" class="org.alfresco.repo.X"/>'),
      'alfresco/module/m/module.properties': 'module.id=m',
      'alfresco/module/m/model/a.xml': model('a:m', 'a', 'http://a'),
    }));
    expect(missingClass.ok).toBe(false);
    expect(missingClass.reason).toMatch(/com\.example\.acme\.Behaviour/);
    expect(missingClass.reason).not.toMatch(/org\.alfresco/);
  });
});
