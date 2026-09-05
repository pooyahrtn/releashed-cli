const HASH = /^[0-9a-f]{64}$/;
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const SOURCE_ID = /^[A-Za-z][A-Za-z0-9-]{0,95}$/;

function exactKeys(value, keys) {
	return (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		JSON.stringify(Object.keys(value).sort()) ===
			JSON.stringify([...keys].sort())
	);
}

function requireCondition(condition, message) {
	if (!condition) throw new Error(`Gate A evaluation refused: ${message}`);
}

function nonemptyStrings(value) {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(item) => typeof item === "string" && item.trim() && item.length <= 2_000,
		)
	);
}

/** Validate the full, private owner rubric without returning any rubric text. */
export function validateGateAEvaluation(evaluation) {
	requireCondition(
		exactKeys(evaluation, [
			"schema",
			"schemaVersion",
			"evaluationVersion",
			"sealed",
			"author",
			"sealingContract",
			"target",
			"reachabilityAndBudget",
			"questions",
			"globalScoringRubric",
			"sourceSnapshot",
		]),
		"unknown or missing top-level fields",
	);
	requireCondition(
		evaluation.schema === "external-flow-map.hidden-artifact-evaluation" &&
			evaluation.schemaVersion === 1 &&
			evaluation.sealed === true &&
			typeof evaluation.evaluationVersion === "string" &&
			evaluation.evaluationVersion.length > 0,
		"schema identity or seal is invalid",
	);

	const seal = evaluation.sealingContract;
	requireCondition(
		seal?.candidateHashBeforeUnseal === true &&
			seal?.candidateMutationAfterUnsealInvalidatesReview === true &&
			seal?.reviewMode ===
				"artifact-only; no live product and no explorer conversation" &&
			seal?.reviewTimeLimitMinutes === 10 &&
			Array.isArray(seal.mustNotBeShownTo) &&
			["public-pack author", "explorer", "map builder"].every((role) =>
				seal.mustNotBeShownTo.includes(role),
			),
		"sealing contract is not the precommitted Gate A boundary",
	);

	requireCondition(
		Array.isArray(evaluation.questions) && evaluation.questions.length >= 3,
		"at least three sealed questions are required",
	);
	const questionIds = new Set();
	for (const question of evaluation.questions) {
		requireCondition(
			exactKeys(question, [
				"id",
				"kind",
				"distinctLearnerGoal",
				"prompt",
				"expectedAnswerElements",
				"evidenceRequirements",
				"scoring",
			]) &&
				QUESTION_ID.test(question.id ?? "") &&
				!questionIds.has(question.id) &&
				typeof question.distinctLearnerGoal === "string" &&
				question.distinctLearnerGoal.trim() &&
				typeof question.prompt === "string" &&
				question.prompt.trim(),
			"question schema is invalid",
		);
		questionIds.add(question.id);
		requireCondition(
			Array.isArray(question.expectedAnswerElements) &&
				question.expectedAnswerElements.length > 0 &&
				question.expectedAnswerElements.every(
					(element) =>
						typeof element?.id === "string" &&
						element.required === true &&
						typeof element.answer === "string" &&
						element.answer.trim() &&
						nonemptyStrings(element.sourceRefs),
				),
			"expected answer elements are invalid",
		);
		const evidence = question.evidenceRequirements;
		const evidencePlan =
			evidence?.requiredSequence ?? evidence?.requiredInspection;
		requireCondition(
			Number.isSafeInteger(evidence?.minimumDirectObservedTransitions) &&
				evidence.minimumDirectObservedTransitions >= 0 &&
				nonemptyStrings(evidencePlan) &&
				(evidence.requiredSequence === undefined ||
					evidence.requiredInspection === undefined) &&
				nonemptyStrings(evidence.requiredArtifacts) &&
				nonemptyStrings(evidence.notAccepted),
			"question evidence requirements are invalid",
		);
		requireCondition(
			exactKeys(question.scoring, ["0", "1", "2"]) &&
				["0", "1", "2"].every(
					(score) =>
						typeof question.scoring[score] === "string" &&
						question.scoring[score].trim(),
				),
			"question scoring is invalid",
		);
	}

	const rubric = evaluation.globalScoringRubric;
	requireCondition(
		rubric?.maximumScore === evaluation.questions.length * 2 &&
			rubric.passingScore === rubric.maximumScore &&
			rubric.perQuestionFloor === 2 &&
			nonemptyStrings(rubric.necessaryPassConditions) &&
			nonemptyStrings(rubric.automaticFailure) &&
			nonemptyStrings(rubric.qualitativeReview),
		"global all-or-nothing scoring rubric is invalid",
	);
	requireCondition(
		Array.isArray(evaluation.sourceSnapshot) &&
			evaluation.sourceSnapshot.length > 0 &&
			evaluation.sourceSnapshot.every(
				(source) =>
					SOURCE_ID.test(source?.id ?? "") && HASH.test(source?.sha256 ?? ""),
			),
		"source snapshot is invalid",
	);

	return {
		evaluation_version: evaluation.evaluationVersion,
		question_count: evaluation.questions.length,
		maximum_score: rubric.maximumScore,
		review_time_limit_minutes: 10,
	};
}
