const TASK_FIELD_LIMITS = Object.freeze({
  name: 200,
  objective: 256 * 1024,
  workingDir: 4096,
  notes: 256 * 1024,
  input: 512 * 1024,
  idempotencyKey: 256,
});

const SKILL_FIELD_LIMITS = Object.freeze({
  name: 200,
  category: 100,
  description: 4096,
  content: 768 * 1024,
  tag: 100,
  tags: 100,
});

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function assertPlainObject(label, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(`${label} must be a JSON object`);
  }
}

function assertStringLength(field, value, maxLength) {
  if (value != null && String(value).length > maxLength) {
    throw validationError(`${field} exceeds the maximum length of ${maxLength}`);
  }
}

function validateTaskBody(body, options = {}) {
  const creating = options.creating !== false;
  const requireId = options.requireId ?? creating;
  assertPlainObject('Task body', body);
  if (requireId && (typeof body.id !== 'string' || !body.id.trim())) {
    throw validationError('id must be a non-empty string');
  }
  for (const field of ['name', 'objective', 'workingDir', 'notes']) {
    if (body[field] != null && typeof body[field] !== 'string') {
      throw validationError(`${field} must be a string`);
    }
    assertStringLength(field, body[field], TASK_FIELD_LIMITS[field]);
  }
  for (const field of ['name', 'objective']) {
    if ((creating || body[field] != null) && !String(body[field] || '').trim()) {
      throw validationError(`${field} cannot be empty`);
    }
  }
  for (const field of ['autoResume', 'enabled']) {
    if (body[field] != null && typeof body[field] !== 'boolean') {
      throw validationError(`${field} must be a boolean`);
    }
  }
  if (body.maxRetries != null
    && (!Number.isInteger(body.maxRetries) || body.maxRetries < 0 || body.maxRetries > 20)) {
    throw validationError('maxRetries must be an integer between 0 and 20');
  }
}

function validateSkillBody(body, options = {}) {
  const creating = options.creating !== false;
  const requireId = options.requireId ?? creating;
  assertPlainObject('Skill body', body);
  if (requireId && (typeof body.id !== 'string' || !body.id.trim())) {
    throw validationError('id must be a non-empty string');
  }
  for (const field of ['name', 'category', 'description', 'content']) {
    if (body[field] != null && typeof body[field] !== 'string') {
      throw validationError(`${field} must be a string`);
    }
    assertStringLength(field, body[field], SKILL_FIELD_LIMITS[field]);
  }
  if ((creating || body.name != null) && !String(body.name || '').trim()) {
    throw validationError('name cannot be empty');
  }
  if (body.enabled != null && typeof body.enabled !== 'boolean') {
    throw validationError('enabled must be a boolean');
  }
  if (body.tags != null && !Array.isArray(body.tags) && typeof body.tags !== 'string') {
    throw validationError('tags must be an array or comma-separated string');
  }
  const tags = Array.isArray(body.tags)
    ? body.tags
    : (typeof body.tags === 'string' ? body.tags.split(',') : []);
  if (tags.some((tag) => typeof tag !== 'string')) {
    throw validationError('every tag must be a string');
  }
  if (tags.length > SKILL_FIELD_LIMITS.tags) {
    throw validationError(`tags exceeds the maximum count of ${SKILL_FIELD_LIMITS.tags}`);
  }
  if (tags.some((tag) => tag.length > SKILL_FIELD_LIMITS.tag)) {
    throw validationError(`every tag must be at most ${SKILL_FIELD_LIMITS.tag} characters`);
  }
}

module.exports = {
  TASK_FIELD_LIMITS,
  SKILL_FIELD_LIMITS,
  assertStringLength,
  validateTaskBody,
  validateSkillBody,
};
