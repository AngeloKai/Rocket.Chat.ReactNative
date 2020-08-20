import EJSON from 'ejson';
import SimpleCrypto from 'react-native-simple-crypto';
import { Q } from '@nozbe/watermelondb';

import {
	toString,
	utf8ToBuffer,
	splitVectorData,
	joinVectorData,
	randomPassword
} from './utils';
import {
	E2E_PUBLIC_KEY,
	E2E_PRIVATE_KEY,
	E2E_RANDOM_PASSWORD_KEY,
	E2E_STATUS,
	E2E_MESSAGE_TYPE
} from './constants';
import RocketChat from '../rocketchat';
import E2ERoom from './encryption.room';
import UserPreferences from '../userPreferences';
import database from '../database';

class Encryption {
	constructor() {
		this.roomInstances = {};
	}

	// Initialize Encryption client
	initialize = () => {
		this.roomInstances = {};

		// Don't await these promises
		// so these can run parallelized
		this.decryptPendingSubscriptions();
		this.decryptPendingMessages();
	}

	// When a new participant join and request a new room encryption key
	provideRoomKeyToUser = async(keyId, roomId) => {
		try {
			const roomE2E = await this.getRoomInstance(roomId);
			if (!roomE2E) {
				return;
			}
			roomE2E.provideKeyToUser(keyId);
		} catch {
			// Do nothing
		}
	}

	// Load stored or sought on server keys
	loadKeys = async(server, publicKey, privateKey) => {
		this.privateKey = await SimpleCrypto.RSA.importKey(EJSON.parse(privateKey));
		await UserPreferences.setStringAsync(`${ server }-${ E2E_PUBLIC_KEY }`, EJSON.stringify(publicKey));
		await UserPreferences.setStringAsync(`${ server }-${ E2E_PRIVATE_KEY }`, privateKey);
	}

	// Could not obtain public-private keypair from server.
	createKeys = async(userId, server) => {
		try {
			const key = await SimpleCrypto.RSA.generateKeys(2048);
			const publicKey = await SimpleCrypto.RSA.exportKey(key.public);
			const privateKey = await SimpleCrypto.RSA.exportKey(key.private);

			this.loadKeys(server, publicKey, EJSON.stringify(privateKey));
			const password = await this.createRandomPassword(server);
			const encodedPrivateKey = await this.encodePrivateKey(EJSON.stringify(privateKey), password, userId);
			await RocketChat.e2eSetUserPublicAndPrivateKeys(EJSON.stringify(publicKey), encodedPrivateKey);
			await RocketChat.e2eRequestSubscriptionKeys();
		} catch {
			// Do nothing
		}
	}

	// Fetch the server stored e2e keys
	fetchMyKeys = async() => {
		// Handling errors here we're able to
		// load the keys without network connect
		try {
			const result = await RocketChat.e2eFetchMyKeys();
			if (result.success) {
				return result;
			}
		} catch {
			// Do nothing
		}
		return {};
	}

	// Encode a private key before send it to the server
	encodePrivateKey = async(privateKey, password, userId) => {
		const masterKey = await this.getMasterKey(password, userId);

		try {
			const vector = await SimpleCrypto.utils.randomBytes(16);
			const data = await SimpleCrypto.AES.encrypt(
				utf8ToBuffer(privateKey),
				masterKey,
				vector
			);

			return EJSON.stringify(new Uint8Array(joinVectorData(vector, data)));
		} catch {
			// Do nothing
		}
	}

	// Decode a private key fetched from server
	decodePrivateKey = async(privateKey, password, userId) => {
		const masterKey = await this.getMasterKey(password, userId);
		const [vector, cipherText] = splitVectorData(EJSON.parse(privateKey));

		const privKey = await SimpleCrypto.AES.decrypt(
			cipherText,
			masterKey,
			vector
		);

		return toString(privKey);
	}

	// Get a user master key, this is based on userId and a password
	getMasterKey = async(password, userId) => {
		const iterations = 1000;
		const hash = 'SHA256';
		const keyLen = 32;

		const passwordBuffer = utf8ToBuffer(password);
		const saltBuffer = utf8ToBuffer(userId);
		try {
			const masterKey = await SimpleCrypto.PBKDF2.hash(
				passwordBuffer,
				saltBuffer,
				iterations,
				keyLen,
				hash
			);

			return masterKey;
		} catch {
			// Do nothing
		}
	}

	// Create a random password to local created keys
	createRandomPassword = async(server) => {
		const password = randomPassword();
		await UserPreferences.setStringAsync(`${ server }-${ E2E_RANDOM_PASSWORD_KEY }`, password);
		return password;
	}

	// get a encryption room instance
	getRoomInstance = async(rid) => {
		if (this.roomInstances[rid]) {
			return this.roomInstances[rid];
		}

		const roomE2E = new E2ERoom(rid);
		await roomE2E.handshake(this.privateKey);
		this.roomInstances[rid] = roomE2E;
		return roomE2E;
	}

	// Logic to decrypt all pending messages/threads/threadMessages
	// after initialize the encryption client
	decryptPendingMessages = async() => {
		const db = database.active;

		const messagesCollection = db.collections.get('messages');
		const threadsCollection = db.collections.get('threads');
		const threadMessagesCollection = db.collections.get('thread_messages');

		// e2e status is 'pending' and message type is 'e2e'
		const whereClause = [Q.where('e2e', E2E_STATUS.PENDING), Q.where('t', E2E_MESSAGE_TYPE)];

		try {
			// Find all messages/threads/threadsMessages that have pending e2e status
			const messagesToDecrypt = await messagesCollection.query(...whereClause).fetch();
			const threadsToDecrypt = await threadsCollection.query(...whereClause).fetch();
			const threadMessagesToDecrypt = await threadMessagesCollection.query(...whereClause).fetch();

			// Concat messages/threads/threadMessages
			const toDecrypt = [...messagesToDecrypt, ...threadsToDecrypt, ...threadMessagesToDecrypt];

			await Promise.all(toDecrypt.map(async(message) => {
				// We should do this to don't try to update the database object
				const { rid, t, msg } = message;
				const decryptedMessage = await this.decryptMessage({ rid, t, msg });
				return db.action(() => message.update((m) => {
					Object.assign(m, decryptedMessage);
				}));
			}));
		} catch {
			// Do nothing
		}
	}

	// Logic to decrypt all pending subscriptions
	// after initialize the encryption client
	decryptPendingSubscriptions = async() => {
		const db = database.active;
		const subCollection = db.collections.get('subscriptions');
		try {
			const subsEncrypted = await subCollection.query(Q.where('encrypted', true)).fetch();
			// We can't do this on database level since lastMessage is not a database object
			const subsToDecrypt = subsEncrypted.filter(sub => sub?.lastMessage?.e2e === E2E_STATUS.PENDING);
			await Promise.all(subsToDecrypt.map(async(sub) => {
				const { lastMessage } = sub;
				const decryptedSub = await this.decryptSubscription({ lastMessage });
				return db.action(() => sub.update((s) => {
					Object.assign(s, decryptedSub);
				}));
			}));
		} catch {
			// Do nothing
		}
	}

	// Decrypt a subscription lastMessage
	decryptSubscription = async(subscription) => {
		if (!subscription?.lastMessage) {
			return subscription;
		}

		try {
			const { lastMessage } = subscription;
			const roomE2E = await this.getRoomInstance(lastMessage.rid);
			const decryptedMessage = await roomE2E.decrypt(lastMessage);
			return {
				...subscription,
				lastMessage: decryptedMessage
			};
		} catch {
			// Do nothing
		}

		return subscription;
	}

	// Encrypt a message
	encryptMessage = async(message) => {
		try {
			// TODO: We should await room instance handshake and this class ready
			const roomE2E = await this.getRoomInstance(message.rid);
			return roomE2E.encrypt(message);
		} catch {
			// Do nothing
		}

		return message;
	}

	// Decrypt a message
	decryptMessage = async(message) => {
		try {
			// TODO: We should await room instance handshake and this class ready
			const roomE2E = await this.getRoomInstance(message.rid);
			return roomE2E.decrypt(message);
		} catch {
			// Do nothing
		}

		return message;
	}
}

const encryption = new Encryption();
export default encryption;
