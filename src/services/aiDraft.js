/**
 * FormGuard — AI Draft Service
 * Uses Claude API to generate unemployment response drafts
 * grounded entirely in stored employee records.
 */

const { query } = require('../db/pool');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

/**
 * Gather all relevant records for an employee to use as AI context.
 * Returns structured data — no raw PII beyond what's needed.
 */
const gatherEmployeeContext = async (employeeId, companyId) => {
  const [emp, profile, writeups, termination, w4, i9] = await Promise.all([
    query(
      `SELECT e.first_name, e.last_name, e.job_title, e.created_at AS hire_date,
              e.employment_status, d.name AS department
       FROM employees e
       LEFT JOIN employee_profiles p ON p.employee_id = e.id
       LEFT JOIN departments d ON d.id = p.department_id
       WHERE e.id = $1 AND e.company_id = $2`,
      [employeeId, companyId]
    ),
    query(
      `SELECT employment_type, start_date FROM employee_profiles WHERE employee_id = $1`,
      [employeeId]
    ),
    query(
      `SELECT incident_date, incident_type, severity, incident_description,
              improvement_plan, status, created_at
       FROM writeups
       WHERE employee_id = $1 AND company_id = $2
       ORDER BY incident_date ASC`,
      [employeeId, companyId]
    ),
    query(
      `SELECT termination_date, termination_type, reason_category,
              eligible_for_rehire, i9_retain_until
       FROM termination_records
       WHERE employee_id = $1 AND company_id = $2`,
      [employeeId, companyId]
    ),
    query(`SELECT submitted_at FROM w4_submissions WHERE employee_id = $1`, [employeeId]),
    query(
      `SELECT section1_completed_at, section2_completed_at FROM i9_submissions WHERE employee_id = $1`,
      [employeeId]
    ),
  ]);

  return {
    employee: emp.rows[0] || null,
    profile: profile.rows[0] || null,
    writeups: writeups.rows,
    termination: termination.rows[0] || null,
    hasW4: w4.rows.length > 0,
    hasI9: i9.rows[0]?.section2_completed_at ? true : false,
  };
};

/**
 * Generate unemployment response draft using Claude API.
 * Only uses data from stored records — never fabricates facts.
 */
const generateUnemploymentDraft = async (employeeId, companyId, userId) => {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured in environment variables.');
  }

  const context = await gatherEmployeeContext(employeeId, companyId);

  if (!context.employee) {
    throw new Error('Employee not found.');
  }
  if (!context.termination) {
    throw new Error('No termination record found. Employee must be terminated before generating an unemployment response.');
  }

  const { employee, profile, writeups, termination } = context;

  // Build structured prompt from real data only
  const systemPrompt = `You are an HR compliance assistant helping a small business respond to an unemployment insurance claim. 
Generate a professional, factual response based ONLY on the provided employee records. 
Do NOT fabricate dates, incidents, or details not present in the records.
Write in a professional, neutral tone appropriate for submission to a state unemployment agency.
Keep the response concise — 3 to 5 paragraphs.
Format the output as plain text with paragraph breaks. Do not use bullet points or headers.`;

  const userPrompt = `Generate an unemployment insurance response letter for the following employee:

EMPLOYEE INFORMATION:
- Name: ${employee.first_name} ${employee.last_name}
- Job Title: ${employee.job_title || 'Not specified'}
- Department: ${employee.department || 'Not specified'}
- Employment Type: ${profile?.employment_type?.replace(/_/g, ' ') || 'Not specified'}
- Hire Date: ${profile?.start_date ? new Date(profile.start_date).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'}) : new Date(employee.hire_date).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})}
- Termination Date: ${new Date(termination.termination_date).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})}
- Termination Type: ${termination.termination_type.replace(/_/g, ' ')}
- Reason Category: ${termination.reason_category?.replace(/_/g, ' ') || 'Not specified'}
- Eligible for Rehire: ${termination.eligible_for_rehire ? 'Yes' : 'No'}

DISCIPLINARY HISTORY (${writeups.length} record${writeups.length !== 1 ? 's' : ''}):
${writeups.length === 0
  ? 'No prior disciplinary records on file.'
  : writeups.map((w, i) =>
    `  ${i + 1}. ${new Date(w.incident_date).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})} — ${w.severity.replace(/_/g, ' ')} for ${w.incident_type.replace(/_/g, ' ')}
     Description: ${w.incident_description}
     Improvement Plan: ${w.improvement_plan || 'None documented'}
     Status: ${w.status}`
  ).join('\n')
}

INSTRUCTIONS:
- Reference specific dates and incidents from the records above
- Explain the sequence of events leading to termination
- Mention any improvement plans that were offered
- State whether the separation was voluntary or involuntary
- Do not include speculation, opinions, or information not in the records above
- End with a statement that supporting documentation is available upon request`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await response.json();
  const draftText = data.content?.[0]?.text || '';

  // Log the draft generation (no PII in log)
  await query(
    `INSERT INTO ai_draft_logs
       (company_id, employee_id, generated_by, draft_type, input_summary)
     VALUES ($1,$2,$3,'unemployment_response',$4)`,
    [
      companyId, employeeId, userId,
      JSON.stringify({
        writeupCount: writeups.length,
        terminationType: termination.termination_type,
        hasImprovementPlan: writeups.some(w => w.improvement_plan),
      }),
    ]
  );

  return {
    draft: draftText,
    context: {
      employeeName: `${employee.first_name} ${employee.last_name}`,
      terminationDate: termination.termination_date,
      terminationType: termination.termination_type,
      writeupCount: writeups.length,
      recordsUsed: [
        'Employee profile',
        writeups.length > 0 ? `${writeups.length} disciplinary record(s)` : null,
        'Termination record',
      ].filter(Boolean),
    },
  };
};

module.exports = { generateUnemploymentDraft, gatherEmployeeContext };
