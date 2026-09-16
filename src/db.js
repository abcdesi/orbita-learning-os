import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, grossPriceForChildren } from './config.js';
import { id, now, hashPassword } from './utils.js';

fs.mkdirSync(path.dirname(config.dbPath), {recursive:true});
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'parent', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
    plan_status TEXT NOT NULL DEFAULT 'trial', trial_ends_at TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT,
    net_collected_cents INTEGER NOT NULL DEFAULT 0, billing_cycle_start TEXT,
    created_at TEXT NOT NULL, FOREIGN KEY(owner_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS household_members (
    household_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
    PRIMARY KEY(household_id,user_id), FOREIGN KEY(household_id) REFERENCES households(id), FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS learners (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL, first_name TEXT NOT NULL, birth_year INTEGER,
    age_band TEXT NOT NULL DEFAULT '9-12', avatar TEXT NOT NULL DEFAULT '🪐',
    accessibility_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
    FOREIGN KEY(household_id) REFERENCES households(id)
  );
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY, learner_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', target_date TEXT, progress REAL NOT NULL DEFAULT 0,
    current_step INTEGER NOT NULL DEFAULT 1, minutes_today INTEGER NOT NULL DEFAULT 15, next_review_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(learner_id) REFERENCES learners(id)
  );
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, domain TEXT NOT NULL,
    description TEXT NOT NULL, prerequisite_slugs TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS learner_skills (
    learner_id TEXT NOT NULL, skill_id TEXT NOT NULL, mastery INTEGER NOT NULL DEFAULT 0,
    retention REAL NOT NULL DEFAULT 0, last_practiced TEXT, evidence_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(learner_id,skill_id), FOREIGN KEY(learner_id) REFERENCES learners(id), FOREIGN KEY(skill_id) REFERENCES skills(id)
  );
  CREATE TABLE IF NOT EXISTS methods (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
    evidence_level TEXT NOT NULL, best_for TEXT NOT NULL, caution TEXT NOT NULL, age_min INTEGER NOT NULL DEFAULT 5
  );
  CREATE TABLE IF NOT EXISTS family_intents (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL, learner_id TEXT, title TEXT NOT NULL,
    domain TEXT NOT NULL, frequency TEXT NOT NULL DEFAULT 'weekly', active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, FOREIGN KEY(household_id) REFERENCES households(id)
  );
  CREATE TABLE IF NOT EXISTS culture_nodes (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, domain TEXT NOT NULL,
    anchor TEXT NOT NULL, content TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
    min_age INTEGER NOT NULL DEFAULT 7
  );
  CREATE TABLE IF NOT EXISTS culture_progress (
    learner_id TEXT NOT NULL, culture_id TEXT NOT NULL, seen_count INTEGER NOT NULL DEFAULT 0,
    recall_score REAL NOT NULL DEFAULT 0, last_seen TEXT,
    PRIMARY KEY(learner_id,culture_id), FOREIGN KEY(learner_id) REFERENCES learners(id), FOREIGN KEY(culture_id) REFERENCES culture_nodes(id)
  );
  CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY, learner_id TEXT NOT NULL, signal_type TEXT NOT NULL, domain TEXT NOT NULL,
    label TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.3, observations INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL, FOREIGN KEY(learner_id) REFERENCES learners(id)
  );
  CREATE TABLE IF NOT EXISTS pods (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL, name TEXT NOT NULL, invite_code TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL, FOREIGN KEY(household_id) REFERENCES households(id)
  );
  CREATE TABLE IF NOT EXISTS pod_members (
    pod_id TEXT NOT NULL, learner_id TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(pod_id,learner_id), FOREIGN KEY(pod_id) REFERENCES pods(id), FOREIGN KEY(learner_id) REFERENCES learners(id)
  );
  CREATE TABLE IF NOT EXISTS learning_sessions (
    id TEXT PRIMARY KEY, learner_id TEXT NOT NULL, goal_id TEXT, session_type TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 0, score REAL, status TEXT NOT NULL DEFAULT 'started',
    started_at TEXT NOT NULL, completed_at TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(learner_id) REFERENCES learners(id), FOREIGN KEY(goal_id) REFERENCES goals(id)
  );
  CREATE TABLE IF NOT EXISTS assessments (
    id TEXT PRIMARY KEY, learner_id TEXT NOT NULL, goal_id TEXT, skill_slug TEXT NOT NULL,
    score REAL NOT NULL, response_ms INTEGER, hint_count INTEGER NOT NULL DEFAULT 0,
    transfer INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    FOREIGN KEY(learner_id) REFERENCES learners(id)
  );
  CREATE TABLE IF NOT EXISTS cost_ledger (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL, category TEXT NOT NULL, provider TEXT NOT NULL,
    operation TEXT NOT NULL, estimated_cents REAL NOT NULL DEFAULT 0, actual_cents REAL NOT NULL DEFAULT 0,
    cycle_key TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
    FOREIGN KEY(household_id) REFERENCES households(id)
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY, household_id TEXT, user_id TEXT, event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_learners_household ON learners(household_id);
  CREATE INDEX IF NOT EXISTS idx_goals_learner ON goals(learner_id,status);
  CREATE INDEX IF NOT EXISTS idx_cost_cycle ON cost_ledger(household_id,cycle_key);
  CREATE INDEX IF NOT EXISTS idx_sessions_learner ON learning_sessions(learner_id,started_at);
  `);
  seedCatalog();
  if(config.nodeEnv!=='production' || process.env.SEED_DEMO==='true') seedDemo();
}

function upsertSkill(slug,name,domain,description,prereqs=[]) {
  db.prepare(`INSERT INTO skills(id,slug,name,domain,description,prerequisite_slugs) VALUES(?,?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET name=excluded.name,domain=excluded.domain,description=excluded.description,prerequisite_slugs=excluded.prerequisite_slugs`)
    .run(id('sk'),slug,name,domain,description,JSON.stringify(prereqs));
}
function upsertMethod(slug,name,category,evidence,bestFor,caution,age=5) {
  db.prepare(`INSERT INTO methods(id,slug,name,category,evidence_level,best_for,caution,age_min) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET name=excluded.name,category=excluded.category,evidence_level=excluded.evidence_level,best_for=excluded.best_for,caution=excluded.caution,age_min=excluded.age_min`)
    .run(id('m'),slug,name,category,evidence,bestFor,caution,age);
}
function upsertCulture(slug,title,domain,anchor,content,question,answer,minAge=7){
  db.prepare(`INSERT INTO culture_nodes(id,slug,title,domain,anchor,content,question,answer,min_age) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET title=excluded.title,domain=excluded.domain,anchor=excluded.anchor,content=excluded.content,question=excluded.question,answer=excluded.answer,min_age=excluded.min_age`)
    .run(id('cu'),slug,title,domain,anchor,content,question,answer,minAge);
}
function seedCatalog(){
  upsertSkill('attention-start','Démarrer sans procrastiner','focus','Transformer une intention en première action observable.');
  upsertSkill('attention-sustain','Maintenir son attention','focus','Rester engagé sur une tâche courte malgré les distracteurs.',['attention-start']);
  upsertSkill('active-recall','Rappel actif','memory','Récupérer une information sans la relire.');
  upsertSkill('spacing','Répétition espacée','memory','Revoir au bon moment pour stabiliser la mémoire.',['active-recall']);
  upsertSkill('multiplication-meaning','Comprendre la multiplication','math','Comprendre groupes égaux et commutativité.');
  upsertSkill('multiplication-anchors','Faits d’ancrage','math','Automatiser ×1, ×2, ×5, ×10.',['multiplication-meaning']);
  upsertSkill('multiplication-derived','Faits dérivés','math','Déduire ×4, ×6, ×9 à partir d’ancres.',['multiplication-anchors']);
  upsertSkill('multiplication-fluency','Fluidité multiplicative','math','Répondre avec précision et rapidité.',['multiplication-derived','active-recall','spacing']);
  upsertSkill('logic-fact-opinion','Fait, opinion, hypothèse','logic','Distinguer ce qui est observé, interprété ou supposé.');
  upsertSkill('logic-causality','Cause et corrélation','logic','Distinguer relation et causalité.',['logic-fact-opinion']);
  upsertSkill('logic-conditions','Conditions logiques','logic','Comprendre nécessaire, suffisant et implication.',['logic-fact-opinion']);
  upsertSkill('language-frequency','Vocabulaire fréquent','language','Prioriser les mots à fort rendement.',['active-recall']);
  upsertSkill('language-chunks','Expressions utiles','language','Apprendre des unités de langage réutilisables.',['language-frequency']);
  upsertSkill('language-listening','Discrimination auditive','language','Reconnaître les sons et mots dans la parole.');
  upsertSkill('mnemonic-association','Associations mnémotechniques','memory','Créer des associations utiles pour des informations arbitraires.',['active-recall']);
  upsertSkill('logic-argument','Structure d’un argument','logic','Identifier prémisses, conclusion et informations manquantes.',['logic-conditions','logic-causality']);
  upsertSkill('logic-probability','Raisonnement sous incertitude','logic','Raisonner avec degrés de confiance et données incomplètes.',['logic-argument']);
  upsertSkill('culture-map','Repères géographiques','culture','Construire une carte mentale du monde à partir de grands repères.');
  upsertSkill('culture-time','Repères chronologiques','culture','Construire une frise mentale avec de grandes périodes.');
  upsertSkill('culture-science','Grandes idées scientifiques','culture','Relier quelques concepts fondamentaux de sciences.');
  upsertSkill('culture-arts','Arts et contextes','culture','Relier œuvres, styles et contextes historiques.');
  upsertSkill('culture-society','Sociétés et institutions','culture','Comprendre quelques notions structurantes de la vie collective.');
  upsertSkill('culture-connect','Relier les connaissances','culture','Accrocher une nouvelle connaissance à des repères déjà connus.',['culture-map','culture-time']);

  upsertMethod('retrieval','Rappel actif','memory','fort','faits, concepts, vocabulaire, consolidation','nécessite feedback et compréhension minimale');
  upsertMethod('spacing','Répétition espacée','memory','fort','rétention à long terme','ne remplace pas la compréhension');
  upsertMethod('worked-example','Exemple résolu','reasoning','fort','procédures et problèmes nouveaux','retirer progressivement l’aide');
  upsertMethod('interleaving','Entrelacement','reasoning','modéré','discriminer plusieurs types de problèmes','utile après une première compréhension');
  upsertMethod('loci','Méthode des loci','mnemonic','modéré','listes, séquences, associations','moins adaptée à la compréhension profonde seule',9);
  upsertMethod('self-explanation','Auto-explication','comprehension','fort','comprendre et détecter ses lacunes','demande un guidage chez les plus jeunes');
  upsertMethod('dual-representation','Double représentation','comprehension','modéré','processus, relations, schémas','éviter la surcharge décorative');

  upsertCulture('base10','Pourquoi comptons-nous en base 10 ?','math-histoire','Nombres et civilisations','Notre écriture décimale organise les nombres par puissances de 10. Le système de numération indo-arabe s’est diffusé progressivement vers l’Europe et facilite les calculs écrits.','Que signifie le 3 dans 3 205 ?','Il représente trois milliers.',7);
  upsertCulture('renaissance-map','Renaissance : remettre les repères','histoire','De l’Antiquité à l’époque moderne','La Renaissance européenne se situe approximativement entre les XIVe et XVIe siècles. Elle relie arts, imprimerie, humanisme, exploration et transformations scientifiques.','La Renaissance vient-elle avant ou après le Moyen Âge ?','Après le Moyen Âge.',8);
  upsertCulture('blue-sky','Pourquoi le ciel paraît bleu ?','sciences','Lumière et atmosphère','La lumière du Soleil contient plusieurs longueurs d’onde. Dans l’atmosphère, les courtes longueurs d’onde sont davantage diffusées, ce qui contribue à la couleur bleue du ciel vue depuis le sol.','Quel élément autour de la Terre diffuse la lumière ?','L’atmosphère.',8);
  upsertCulture('continents-oceans','La carte mentale du monde','géographie','Repères mondiaux','Construire une carte mentale commence par les continents, les grands océans et quelques lignes de repère avant d’ajouter pays, reliefs et villes.','Quel océan sépare principalement l’Europe de l’Amérique ?','L’océan Atlantique.',7);
  upsertCulture('earth-scale','La Terre à l’échelle du système solaire','sciences','Terre → système solaire → galaxie','La Terre est une planète du système solaire. Le Soleil est une étoile parmi des centaines de milliards dans la Voie lactée. Construire ces niveaux évite de confondre planète, étoile et galaxie.','Le Soleil est-il une planète ou une étoile ?','Une étoile.',8);
  upsertCulture('writing','Pourquoi l’écriture a changé les sociétés','histoire','Mémoire collective','L’écriture permet de conserver des informations au-delà de la mémoire individuelle : comptes, lois, récits et administration. Plusieurs systèmes d’écriture sont apparus dans différentes régions du monde.','Cite une chose que l’écriture permet de conserver.','Par exemple des lois, comptes ou récits.',8);
  upsertCulture('printing','L’imprimerie et la circulation des idées','histoire-tech','Renaissance et information','En Europe, l’imprimerie à caractères mobiles accélère au XVe siècle la reproduction de textes. Elle contribue à une diffusion plus large des savoirs et des débats.','Quel changement majeur apporte l’imprimerie ?','Elle permet de reproduire et diffuser des textes beaucoup plus facilement.',9);
  upsertCulture('cells','La cellule : une unité du vivant','sciences','Du corps au vivant','De nombreux êtres vivants sont constitués de cellules. Les cellules ont des structures et fonctions variées, mais cette idée fournit un repère fondamental pour comprendre la biologie.','Comment appelle-t-on l’une des unités de base du vivant ?','La cellule.',9);
  upsertCulture('money','À quoi sert la monnaie ?','économie','Échanges et choix','La monnaie sert notamment d’intermédiaire d’échange, d’unité pour comparer des valeurs et de réserve de valeur. Elle ne supprime pas la rareté : choisir une dépense signifie renoncer à une autre possibilité.','Pourquoi un budget oblige-t-il à faire des choix ?','Parce que les ressources disponibles sont limitées.',9);
  upsertCulture('perspective','La perspective dans l’art','arts','Art et représentation','La perspective linéaire est une manière de représenter la profondeur sur une surface plane en organisant les lignes vers des points de fuite. Elle devient particulièrement importante dans l’art européen de la Renaissance.','À quoi sert un point de fuite ?','À organiser l’illusion de profondeur dans une représentation.',10);
  upsertCulture('vaccines','Vaccins : entraîner le système immunitaire','sciences-santé','Corps et prévention','Un vaccin présente au système immunitaire une information lui permettant de reconnaître plus vite un agent infectieux ou une partie de celui-ci. Les technologies vaccinales sont diverses.','Quel système du corps apprend à mieux reconnaître certains agents après vaccination ?','Le système immunitaire.',10);
  upsertCulture('longitude','Comment se repérer sur Terre','géographie','Latitude et longitude','La latitude mesure la position au nord ou au sud de l’équateur ; la longitude mesure la position à l’est ou à l’ouest d’un méridien de référence. Ensemble, elles permettent de localiser un point.','La latitude indique-t-elle plutôt nord/sud ou est/ouest ?','Nord/sud.',9);
}

function seedDemo(){
  const exists=db.prepare('SELECT id FROM users WHERE email=?').get('demo@orbita.local');
  if(exists) return;
  const uid=id('usr'), hid=id('hh'), lid=id('lrn'), gid=id('goal');
  db.prepare('INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES(?,?,?,?,?,?)').run(uid,'demo@orbita.local',hashPassword('Demo123!'),'Camille Parent','parent',now());
  db.prepare('INSERT INTO households(id,owner_user_id,name,plan_status,trial_ends_at,net_collected_cents,billing_cycle_start,created_at) VALUES(?,?,?,?,?,?,?,?)').run(hid,uid,'Famille Démo','active',null,1990,new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString(),now());
  db.prepare('INSERT INTO household_members(household_id,user_id,role) VALUES(?,?,?)').run(hid,uid,'owner');
  db.prepare('INSERT INTO learners(id,household_id,first_name,birth_year,age_band,avatar,accessibility_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(lid,hid,'Lina',2016,'9-12','🪐',JSON.stringify({shortInstructions:true,audio:false,largeText:false,reducedVisual:false}),now());
  db.prepare('INSERT INTO goals(id,learner_id,kind,title,status,target_date,progress,current_step,minutes_today,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(gid,lid,'tables','Maîtriser mes tables en 7 jours','active',new Date(Date.now()+6*86400000).toISOString(),0.47,4,16,now(),now());
  db.prepare('INSERT INTO family_intents(id,household_id,learner_id,title,domain,frequency,active,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id('fi'),hid,lid,'Apprendre à gérer un petit budget','autonomie','weekly',1,now());
  db.prepare('INSERT INTO signals(id,learner_id,signal_type,domain,label,confidence,observations,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id('sig'),lid,'interest','sciences','Curiosité pour le vivant et les phénomènes naturels',0.68,7,now());
  const pod=id('pod'); db.prepare('INSERT INTO pods(id,household_id,name,invite_code,created_at) VALUES(?,?,?,?,?)').run(pod,hid,'Les Explorateurs','ORBITA7',now());
  db.prepare('INSERT INTO pod_members(pod_id,learner_id,points) VALUES(?,?,?)').run(pod,lid,63);
}

export function cycleKey(date=new Date()){ return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`; }
export function getHouseholdForUser(userId){ return db.prepare(`SELECT h.* FROM households h JOIN household_members hm ON hm.household_id=h.id WHERE hm.user_id=? LIMIT 1`).get(userId); }
export function childrenCount(householdId){ return Number(db.prepare('SELECT COUNT(*) c FROM learners WHERE household_id=?').get(householdId)?.c||0); }
export function pricingForHousehold(householdId){ const count=childrenCount(householdId); return {children:count,grossCents:grossPriceForChildren(count)}; }
