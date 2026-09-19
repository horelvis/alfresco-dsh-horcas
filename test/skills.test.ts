import { describe, expect, it } from 'vitest';
import {
  loadRecommendationSkill,
  migrationPlaybookSkill,
  planningHeuristicsSkill,
  readinessChecklistSkill,
  storageMountsSkill,
  upgradeGatesSkill,
} from '../src/skills.js';

describe('skills de conocimiento', () => {
  it('gates: incluye 26.2 EE con Solr-off y 23.4 sin Java 21', () => {
    const skill = upgradeGatesSkill();
    expect(skill.name).toBe('alfresco-upgrade-gates');
    expect(skill.content).toContain('26.2 EE');
    expect(skill.content).toContain('Solr debe desmantelarse');
    expect(skill.content).toContain('Java 21');
  });

  it('playbook: describe el flujo ensayo -> prod y las reglas duras', () => {
    const skill = migrationPlaybookSkill();
    expect(skill.content).toContain('migrator_rehearsal_record');
    expect(skill.content).toContain('ORIGEN es inmutable');
    expect(skill.content).toContain('REPLICA IDENTITY');
  });

  it('recomendaciones: carga el catalogo oficial desde data', async () => {
    const skill = await loadRecommendationSkill();
    expect(skill.name).toBe('alfresco-migration-recommendations');
    expect(skill.content).toContain('COHERENCE_DANGLING');
    expect(skill.content).toContain('docs.hyland.com');
  });

  it('planificacion: umbrales de estrategia y cuello de botella', () => {
    const skill = planningHeuristicsSkill();
    expect(skill.content).toContain('C1-C5');
    expect(skill.content).toContain('schema-upgrade');
    expect(skill.content).toContain('REPLICA IDENTITY');
  });

  it('checklist: items pre/post y evidencia', () => {
    const skill = readinessChecklistSkill();
    expect(skill.content).toContain('SHA-256');
    expect(skill.content).toContain('dangling=0');
    expect(skill.content).toContain('PENDING');
  });

  it('montajes: incluye la seccion de confirmacion humana', () => {
    const skill = storageMountsSkill();
    expect(skill.content).toContain('datastore');
    expect(skill.content).toContain('ask_user');
    expect(skill.content).toContain('requiresHumanConfirmation');
  });
});
