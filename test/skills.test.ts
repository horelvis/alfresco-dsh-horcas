import { describe, expect, it } from 'vitest';
import { loadRecommendationSkill, migrationPlaybookSkill, upgradeGatesSkill } from '../src/skills.js';

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
});
