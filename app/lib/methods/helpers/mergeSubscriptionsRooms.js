import EJSON from 'ejson';

import normalizeMessage from './normalizeMessage';
import findSubscriptionsRooms from './findSubscriptionsRooms';
// import { Encryption } from '../../encryption';
// TODO: delete and update

export const merge = (subscription, room) => {
	subscription = EJSON.fromJSONValue(subscription);
	room = EJSON.fromJSONValue(room);

	if (!subscription) {
		return;
	}
	if (room) {
		if (room._updatedAt) {
			subscription.roomUpdatedAt = room._updatedAt;
			subscription.lastMessage = normalizeMessage(room.lastMessage);
			subscription.description = room.description;
			subscription.topic = room.topic;
			subscription.announcement = room.announcement;
			subscription.reactWhenReadOnly = room.reactWhenReadOnly;
			subscription.archived = room.archived || false;
			subscription.joinCodeRequired = room.joinCodeRequired;
			subscription.jitsiTimeout = room.jitsiTimeout;
			subscription.usernames = room.usernames;
			subscription.uids = room.uids;
		}
		subscription.ro = room.ro;
		subscription.broadcast = room.broadcast;
		subscription.encrypted = room.encrypted;
		if (!subscription.roles || !subscription.roles.length) {
			subscription.roles = [];
		}
		if (room.muted && room.muted.length) {
			subscription.muted = room.muted.filter(muted => !!muted);
		} else {
			subscription.muted = [];
		}
		if (room.v) {
			subscription.visitor = room.v;
		}
		if (room.departmentId) {
			subscription.departmentId = room.departmentId;
		}
		if (room.servedBy) {
			subscription.servedBy = room.servedBy;
		}
		if (room.livechatData) {
			subscription.livechatData = room.livechatData;
		}
		if (room.tags) {
			subscription.tags = room.tags;
		}
		subscription.sysMes = room.sysMes;
	}

	if (!subscription.name) {
		subscription.name = subscription.fname;
	}

	if (!subscription.autoTranslate) {
		subscription.autoTranslate = false;
	}

	subscription.blocker = !!subscription.blocker;
	subscription.blocked = !!subscription.blocked;
	return subscription;
};

export default async(subscriptions = [], rooms = []) => {
	if (subscriptions.update) {
		subscriptions = subscriptions.update;
		rooms = rooms.update;
	}

	// TODO: This is blocking the first fetch after login
	// rooms = await Promise.all(rooms.map(room => Encryption.decryptSubscription(room)));
	({ subscriptions, rooms } = await findSubscriptionsRooms(subscriptions, rooms));

	return {
		subscriptions: subscriptions.map((s) => {
			const index = rooms.findIndex(({ _id }) => _id === s.rid);
			if (index < 0) {
				return merge(s);
			}
			const [room] = rooms.splice(index, 1);
			return merge(s, room);
		}),
		rooms
	};
};
