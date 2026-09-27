/**
 * STACK de la version FINAL (solo el ultimo hop; los intermedios son repositorio + infra): Share,
 * transform-core-aio, proxy en un unico puerto y las EXTENSIONES migradas (AMPs/JARs/config) que el humano
 * deja en una carpeta del DESTINO. Lo que se despliega lo decide el humano (`target.stack`, preguntado por
 * el arnes): cada migracion es distinta.
 *
 * Valores de referencia del compose OFICIAL de Community (Alfresco/acs-deployment):
 * v10.8.0 (26.2): share 26.2.2, transform-core-aio 5.4.4; v10.0.0 (25.2): share 25.2.0, transform 5.2.2.
 */
import { parseVersion } from './versions.js';

export interface FinalStack {
  share?: boolean;
  transform?: boolean;
  proxy?: boolean;
  /** Host con el que los usuarios acceden (URLs de Share/CSRF/AOS). Defecto: localhost. */
  publicHost?: string;
  shareImage?: string;
  transformImage?: string;
  /** Carpetas EN EL DESTINO con `amps/`, `jars/` y `config/` ya migrados a la version final. */
  extensions?: { repo?: string; share?: string };
}

const OFFICIAL: Record<string, { share: string; transform: string }> = {
  '26.2': { share: '26.2.2', transform: '5.4.4' },
  '25.2': { share: '25.2.0', transform: '5.2.2' },
};

const minor = (version: string): string => parseVersion(version).slice(0, 2).join('.');
const exact = (version: string): string => (version.split('.').length >= 3 ? version : `${version}.0`);

export function shareImage(stack: FinalStack, version: string, edition: string): string {
  if (stack.shareImage) return stack.shareImage;
  const repo = edition === 'EE' ? 'quay.io/alfresco/alfresco-share' : 'alfresco/alfresco-share';
  return `${repo}:${OFFICIAL[minor(version)]?.share ?? exact(version)}`;
}

export function transformImage(stack: FinalStack, version: string): string {
  return stack.transformImage ?? `alfresco/alfresco-transform-core-aio:${OFFICIAL[minor(version)]?.transform ?? '5.4.4'}`;
}

/** ActiveMQ 6.x (ACS 26+) trae la autenticacion activada: el repositorio necesita credenciales del broker. */
export const brokerNeedsAuth = (version: string): boolean => (parseVersion(version)[0] ?? 0) >= 26;

/** Propiedades JVM del repositorio para el stack final (como el compose oficial). */
export function repositoryJavaOpts(stack: FinalStack | undefined, version: string): string[] {
  const opts: string[] = [];
  if (brokerNeedsAuth(version)) {
    opts.push(
      // La URL va CITADA dentro de JAVA_OPTS: catalina.sh la pasa por `eval` y los parentesis de
      // `failover:(...)` rompen el shell si no hay comillas (como en el compose oficial).
      '-Dmessaging.broker.url="failover:(nio://activemq:61616)?timeout=3000"',
      '-Dmessaging.broker.username=${ACTIVEMQ_ADMIN_LOGIN}',
      '-Dmessaging.broker.password=${ACTIVEMQ_ADMIN_PASSWORD}',
    );
  }
  if (!stack) return opts;
  const host = stack.publicHost ?? 'localhost';
  if (stack.share || stack.proxy) {
    opts.push(`-Dshare.host=${host}`, '-Dshare.port=8080', `-Dalfresco.host=${host}`, '-Dalfresco.port=8080', '-Dcsrf.filter.enabled=false');
    opts.push(`-Daos.baseUrlOverwrite=http://${host}:8080/alfresco/aos`);
  }
  if (stack.transform) opts.push('-DlocalTransform.core-aio.url=http://transform-core-aio:8090/');
  return opts;
}

/**
 * Dockerfile inline de una imagen DERIVADA con las extensiones migradas: instala `amps/` con alfresco-mmt,
 * copia `jars/` a WEB-INF/lib y `config/` a shared/classes (cada subcarpeta es opcional).
 */
export function extensionDockerfile(base: string, webapp: 'alfresco' | 'share'): string {
  const tomcat = '/usr/local/tomcat';
  return [
    `FROM ${base}`,
    'USER root',
    'COPY . /tmp/ext/',
    `RUN if [ -d /tmp/ext/amps ] && ls /tmp/ext/amps/*.amp >/dev/null 2>&1; then java -jar ${tomcat}/alfresco-mmt/alfresco-mmt*.jar install /tmp/ext/amps ${tomcat}/webapps/${webapp} -directory -nobackup -force; fi` +
      ` && if [ -d /tmp/ext/jars ]; then cp /tmp/ext/jars/*.jar ${tomcat}/webapps/${webapp}/WEB-INF/lib/ 2>/dev/null || true; fi` +
      ` && if [ -d /tmp/ext/config ]; then cp -r /tmp/ext/config/. ${tomcat}/shared/classes/; fi` +
      ' && rm -rf /tmp/ext',
    ...(webapp === 'alfresco' ? [`RUN chown -R 33000 ${tomcat}`, 'USER 33000'] : []),
  ].join('\n');
}

/**
 * Configuracion del proxy (nginx): `/` y `/alfresco` -> repositorio, `/share` -> Share, en el puerto 8080.
 * Resolucion DIFERIDA (resolver de Docker + variables): arranca con la infra aunque Alfresco/Share aun no
 * existan. Bloquea la API de Solr desde fuera, como el proxy oficial.
 */
export function proxyConfig(share: boolean): string {
  return [
    'events {}',
    'http {',
    '  client_max_body_size 0;',
    '  proxy_read_timeout 1200s;',
    '  resolver 127.0.0.11 valid=10s ipv6=off;',
    '  server {',
    '    listen 8080;',
    '    set $repo http://alfresco:8080;',
    ...(share ? ['    set $share http://share:8080;'] : []),
    '    location ~ ^/alfresco/(wc)?s(ervice)?/api/solr/ { return 403; }',
    ...(share
      ? [
          '    location ~ ^/share/proxy/alfresco(-(noauth|feed|api))?/api/solr/ { return 403; }',
          '    location = /share { return 301 /share/; }',
          '    location /share/ { proxy_pass $share; proxy_set_header Host $host:8080; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }',
        ]
      : []),
    '    location / { proxy_pass $repo; proxy_set_header Host $host:8080; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }',
    '  }',
    '}',
    '',
  ].join('\n');
}

/** Servicios a levantar con la infraestructura (antes de Alfresco): transform y proxy. */
export function stackInfraServices(stack: FinalStack | undefined): string[] {
  if (!stack) return [];
  return [...(stack.transform ? ['transform-core-aio'] : []), ...(stack.proxy ? ['proxy'] : [])];
}

/** Servicios a levantar DESPUES de que el repositorio responda (Share depende de el). */
export function stackLateServices(stack: FinalStack | undefined): string[] {
  return stack?.share ? ['share'] : [];
}
