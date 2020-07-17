import database, { schemaInspector } from '../database';
import { Query } from '../types/query';
import runAST from '../database/run-ast';
import getASTFromQuery from '../utils/get-ast-from-query';
import { Accountability, Operation, Item } from '../types';

import * as PayloadService from './payload';
import * as PermissionsService from './permissions';
import * as ActivityService from './activity';
import * as RevisionsService from './revisions';

import { pick, clone } from 'lodash';
import logger from '../logger';

/**
 * @todo
 * have this support passing in a knex instance, so we can hook it up to the same TX instance
 * as batch insert / update
 */
async function saveActivityAndRevision(
	action: ActivityService.Action,
	collection: string,
	item: string,
	payload: Partial<Item>,
	accountability: Accountability
) {
	const activityID = await ActivityService.createActivity({
		action,
		collection,
		item,
		ip: accountability.ip,
		user_agent: accountability.userAgent,
		action_by: accountability.user,
	});

	if (action !== ActivityService.Action.DELETE) {
		await RevisionsService.createRevision({
			activity: activityID,
			collection,
			item,
			delta: payload,
			/** @todo make this configurable */
			data: await readItem(collection, item, { fields: ['*'] }),
			parent: accountability.parent,
		});
	}
}

export async function createItem(
	collection: string,
	data: Partial<Item>[],
	accountability?: Accountability
): Promise<(string | number)[]>;
export async function createItem(
	collection: string,
	data: Partial<Item>,
	accountability?: Accountability
): Promise<string | number>;
export async function createItem(
	collection: string,
	data: Partial<Item> | Partial<Item>[],
	accountability?: Accountability
): Promise<string | number | (string | number)[]> {
	const isBatch = Array.isArray(data);

	return database.transaction(async (tx) => {
		let payloads = isBatch ? data : [data];

		const primaryKeys: (string | number)[] = await Promise.all(
			payloads.map(async (payload: Partial<Item>) => {
				if (accountability && accountability.admin === false) {
					payload = await PermissionsService.processValues(
						'create',
						collection,
						accountability?.role,
						payload
					);
				}

				payload = await PayloadService.processValues('create', collection, payload);

				payload = await PayloadService.processM2O(collection, payload);

				const primaryKeyField = await schemaInspector.primary(collection);
				// Only insert the values that actually save to an existing column. This ensures we ignore aliases etc
				const columns = await schemaInspector.columns(collection);
				const payloadWithoutAlias = pick(
					payload,
					columns.map(({ column }) => column)
				);

				const primaryKeys = await tx(collection)
					.insert(payloadWithoutAlias)
					.returning(primaryKeyField);

				// This allows the o2m values to be populated correctly
				payload[primaryKeyField] = primaryKeys[0];

				await PayloadService.processO2M(collection, payload);

				if (accountability) {
					// Don't await this. It can run async in the background
					saveActivityAndRevision(
						ActivityService.Action.CREATE,
						collection,
						primaryKeys[0],
						payloadWithoutAlias,
						accountability
					).catch((err) => logger.error(err));
				}

				return primaryKeys[0];
			})
		);

		if (isBatch) {
			return primaryKeys;
		} else {
			return primaryKeys[0];
		}
	});
}

export const readItems = async <T = Partial<Item>>(
	collection: string,
	query: Query,
	accountability?: Accountability
): Promise<T[]> => {
	let ast = await getASTFromQuery(collection, query, accountability);

	if (accountability && accountability.admin === false) {
		ast = await PermissionsService.processAST(ast, accountability.role);
	}

	const records = await runAST(ast);
	return await PayloadService.processValues('read', collection, records);
};

export const readItem = async <T extends number | string | (number | string)[]>(
	collection: string,
	pk: T,
	query: Query = {},
	accountability?: Accountability,
	operation?: Operation
): Promise<T extends number | string ? Partial<Item> : Partial<Item>[]> => {
	// We allow overriding the operation, so we can use the item read logic to validate permissions
	// for update and delete as well
	operation = operation || 'read';

	const primaryKeyField = await schemaInspector.primary(collection);
	const primaryKeys: any[] = Array.isArray(pk) ? pk : [pk];
	const isBatch = Array.isArray(pk);

	if (isBatch) {
		query = {
			...query,
			filter: {
				...(query.filter || {}),
				[primaryKeyField]: {
					_in: primaryKeys,
				},
			},
		};
	} else {
		query = {
			...query,
			filter: {
				...(query.filter || {}),
				[primaryKeyField]: {
					_eq: pk,
				},
			},
		};
	}

	let ast = await getASTFromQuery(collection, query, accountability, operation);

	if (accountability && accountability.admin === false) {
		ast = await PermissionsService.processAST(ast, accountability.role, operation);
	}

	const records = await runAST(ast);
	const processedRecords = await PayloadService.processValues('read', collection, records);
	return isBatch ? processedRecords : processedRecords[0];
};

export const updateItem = async <T extends number | string | (number | string)[]>(
	collection: string,
	pk: T,
	data: Partial<Item>,
	accountability?: Accountability
): Promise<T> => {
	const primaryKeys: any[] = Array.isArray(pk) ? pk : [pk];

	await database.transaction(async (tx) => {
		let payload = clone(data);

		return await Promise.all(
			primaryKeys.map(async (key) => {
				if (accountability && accountability.admin === false) {
					await PermissionsService.checkAccess(
						'update',
						collection,
						key,
						accountability.role
					);

					payload = await PermissionsService.processValues(
						'validate',
						collection,
						accountability.role,
						data
					);
				}

				payload = await PayloadService.processValues('update', collection, payload);
				payload = await PayloadService.processM2O(collection, payload);

				const primaryKeyField = await schemaInspector.primary(collection);

				// Only insert the values that actually save to an existing column. This ensures we ignore aliases etc
				const columns = await schemaInspector.columns(collection);

				const payloadWithoutAlias = pick(
					payload,
					columns.map(({ column }) => column)
				);

				await tx(collection)
					.update(payloadWithoutAlias)
					.where({ [primaryKeyField]: key });

				if (accountability) {
					// Don't await this. It can run async in the background
					// saveActivityAndRevision(
					// 	ActivityService.Action.UPDATE,
					// 	collection,
					// 	String(pk),
					// 	payloadWithoutAlias,
					// 	accountability
					// ).catch((err) => logger.error(err));
				}

				return pk;
			})
		);
	});

	return pk;
};

export const deleteItem = async <T extends number | string | (number | string)[]>(
	collection: string,
	pk: T,
	accountability?: Accountability
): Promise<T> => {
	const primaryKeyField = await schemaInspector.primary(collection);
	const primaryKeys: any[] = Array.isArray(pk) ? pk : [pk];

	await database.transaction(async (tx) => {
		await Promise.all(
			primaryKeys.map(async (key) => {
				if (accountability && accountability.admin === false) {
					await PermissionsService.checkAccess(
						'delete',
						collection,
						key,
						accountability.role
					);
				}

				await tx(collection)
					.where({ [primaryKeyField]: key })
					.delete();
			})
		);
	});

	// Don't await this. It can run async in the background
	// saveActivityAndRevision(
	// 	ActivityService.Action.DELETE,
	// 	collection,
	// 	String(pk),
	// 	{},
	// 	accountability
	// ).catch((err) => logger.error(err));

	return pk;
};

export const readSingleton = async (
	collection: string,
	query: Query,
	accountability?: Accountability
) => {
	query.limit = 1;

	const records = await readItems(collection, query, accountability);
	const record = records[0];

	if (!record) {
		const columns = await schemaInspector.columnInfo(collection);
		const defaults = {};

		for (const column of columns) {
			defaults[column.name] = column.default_value;
		}

		return defaults;
	}

	return record;
};

export const upsertSingleton = async (
	collection: string,
	data: Partial<Item>,
	accountability: Accountability
) => {
	const primaryKeyField = await schemaInspector.primary(collection);
	const record = await database.select(primaryKeyField).from(collection).limit(1).first();

	if (record) {
		return await updateItem(collection, record.id, data, accountability);
	}

	return await createItem(collection, data, accountability);
};
