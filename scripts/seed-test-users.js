const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');

const db = new Database(path.join(__dirname, '..', '.nectar.db'));
const now = new Date().toISOString();
const secret = 'nectar-default-jwt-secret';

// Seed roles
const allCaps = JSON.stringify([
  'config.read', 'config.write', 'release.write', 'environment.write',
  'sync.trigger', 'task.write', 'notify.send', 'user.admin', 'system.admin',
]);
db.prepare(`INSERT OR IGNORE INTO roles (id,name,description,capabilities,system,createdAt,updatedAt)
  VALUES ('admin','Admin','Full system access',?,1,?,?)`).run(allCaps, now, now);
db.prepare(`INSERT OR IGNORE INTO roles (id,name,description,capabilities,system,createdAt,updatedAt)
  VALUES ('viewer','Viewer','Read-only access','["config.read"]',1,?,?)`).run(now, now);

// Create test users
const emptyJson = '{}';
const users = [
  { email: 'eric@test.com', name: 'Eric (Admin)', role: 'admin', roleId: 'admin' },
  { email: 'viewer@test.com', name: 'Viewer User', role: 'user', roleId: 'viewer' },
  { email: 'release@test.com', name: 'Release Manager', role: 'user', roleId: 'viewer' },
];

for (const u of users) {
  db.prepare(`INSERT OR REPLACE INTO users (email,name,picture,role,notificationPrefs,lastLoginAt,createdAt)
    VALUES (?,?,NULL,?,?,?,?)`).run(u.email, u.name, u.role, emptyJson, now, now);
  db.prepare(`INSERT OR IGNORE INTO user_roles (email,roleId,grantedBy,grantedAt)
    VALUES (?,?,?,?)`).run(u.email, u.roleId, 'seed', now);
}

console.log('\n=== Test Users ===');
console.log('1. Eric (Admin)     — admin role, all 9 capabilities');
console.log('2. Viewer User      — viewer role, config.read only');
console.log('3. Release Manager  — viewer role (assign release_lead from the UI to test)\n');

console.log('=== Login URLs (paste in browser) ===\n');
for (const u of users) {
  const token = jwt.sign(
    { email: u.email, name: u.name, picture: null, domain: 'test.com', role: u.role },
    secret, { expiresIn: '7d' }
  );
  console.log(`${u.name}:`);
  console.log(`  javascript:document.cookie='nectar_session=${token};path=/;max-age=604800';location.reload()`);
  console.log('');
}

db.close();
