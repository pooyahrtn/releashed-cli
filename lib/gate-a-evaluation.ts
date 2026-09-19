const HASH = /^[0-9a-f]{64}$/;
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const SOURCE_ID = /^[A-Za-z][A-Za-z0-9-]{0,95}$/;

function exactKeys(
	value: unknown,
	keys: string[],
): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		JSON.stringify(Object.keys(value).sort()) ===
			JSON.stringify([...keys].sort())
	);
}

function requireCondition(
	condition: unknown,
	message: string,
): asserts condition {
	if (!condition) throw new Error(`Gate A evaluation refused: ${message}`);
}

function nonemptyStrings(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(item): item is string =>
				typeof item === "string" && !!item.trim() && item.length <= 2_000,
		)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export type GateAEvaluationSummary = {
	evaluation_version: string;
	question_count: number;
	maximum_score: number;
	review_time_limit_minutes: number;
};

/** Validate the full, private owner rubric without returning any rubric text. */
export function validateGateAEvaluation(
	evaluation: unknown,
): GateAEvaluationSummary {
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
		isRecord(seal) &&
			seal.candidateHashBeforeUnseal === true &&
			seal.candidateMutationAfterUnsealInvalidatesReview === true &&
			seal.reviewMode ===
				"artifact-only; no live product and no explorer conversation" &&
			seal.reviewTimeLimitMinutes === 10 &&
			Array.isArray(seal.mustNotBeShownTo) &&
			seal.mustNotBeShownTo.includes("public-pack author") &&
			seal.mustNotBeShownTo.includes("explorer") &&
			seal.mustNotBeShownTo.includes("map builder"),
		"sealing contract is not the precommitted Gate A boundary",
	);

	const questions = evaluation.questions;
	requireCondition(
		Array.isArray(questions) && questions.length >= 3,
		"at least three sealed questions are required",
	);
	const questionIds = new Set<string>();
	for (const question of questions) {
		requireCondition(
			exactKeys(question, [
				"id",
				"kind",
				"distinctLearnerGoal",
				"prompt",
				"expectedAnswerElements",
				"evidenceRequirements",
				"scoring",
			]),
			"question schema is invalid",
		);
		// RegExp.test coerces its argument, so String() here matches the
		// original exactly while giving strict TS a string.
		const questionId = String(question.id ?? "");
		requireCondition(
			QUESTION_ID.test(questionId) &&
				!questionIds.has(questionId) &&
				typeof question.distinctLearnerGoal === "string" &&
				question.distinctLearnerGoal.trim() &&
				typeof question.prompt === "string" &&
				question.prompt.trim(),
			"question schema is invalid",
		);
		questionIds.add(questionId);
		requireCondition(
			Array.isArray(question.expectedAnswerElements) &&
				question.expectedAnswerElements.length > 0 &&
				question.expectedAnswerElements.every(
					(element) =>
						isRecord(element) &&
						typeof element.id === "string" &&
						element.required === true &&
						typeof element.answer === "string" &&
						element.answer.trim() &&
						nonemptyStrings(element.sourceRefs),
				),
			"expected answer elements are invalid",
		);
		const evidence = question.evidenceRequirements;
		requireCondition(
			isRecord(evidence) &&
				typeof evidence.minimumDirectObservedTransitions === "number" &&
				Number.isSafeInteger(
					evidence.minimumDirectObservedTransitions,
				) &&
				evidence.minimumDirectObservedTransitions >= 0,
			"question evidence requirements are invalid",
		);
		const evidencePlan =
			evidence.requiredSequence ?? evidence.requiredInspection;
		requireCondition(
			nonemptyStrings(evidencePlan) &&
				(evidence.requiredSequence === undefined ||
					evidence.requiredInspection === undefined) &&
				nonemptyStrings(evidence.requiredArtifacts) &&
				nonemptyStrings(evidence.notAccepted),
			"question evidence requirements are invalid",
		);
		requireCondition(
			exactKeys(question.scoring, ["0", "1", "2"]) &&
				typeof question.scoring["0"] === "string" &&
				question.scoring["0"].trim() &&
				typeof question.scoring["1"] === "string" &&
				question.scoring["1"].trim() &&
				typeof question.scoring["2"] === "string" &&
				question.scoring["2"].trim(),
			"question scoring is invalid",
		);
	}

	const rubric = evaluation.globalScoringRubric;
	requireCondition(
		isRecord(rubric) &&
			rubric.maximumScore === questions.length * 2 &&
			rubric.passingScore === rubric.maximumScore &&
			rubric.perQuestionFloor === 2 &&
			nonemptyStrings(rubric.necessaryPassConditions) &&
			nonemptyStrings(rubric.automaticFailure) &&
			nonemptyStrings(rubric.qualitativeReview),
		"global all-or-nothing scoring rubric is invalid",
	);
	const sourceSnapshot = evaluation.sourceSnapshot;
	requireCondition(
		Array.isArray(sourceSnapshot) &&
			sourceSnapshot.length > 0 &&
			sourceSnapshot.every(
				(source) =>
					isRecord(source) &&
					SOURCE_ID.test(String(source.id ?? "")) &&
					HASH.test(String(source.sha256 ?? "")),
			),
		"source snapshot is invalid",
	);

	return {
		evaluation_version: evaluation.evaluationVersion,
		question_count: questions.length,
		maximum_score: questions.length * 2,
		review_time_limit_minutes: 10,
	};
}
