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
	E2E_MESSAGE_TYPE,
	E2E_ROOM_TYPES
} from './constants';
import RocketChat from '../rocketchat';
import EncryptionRoom from './encryption.room';
import UserPreferences from '../userPreferences';
import database from '../database';
import protectedFunction from '../methods/helpers/protectedFunction';

class Encryption {
	constructor() {
		this.ready = false;
		this.privateKey = null;
		this.roomInstances = {};
	}

	// Initialize Encryption client
	initialize = () => {
		this.roomInstances = {};

		// Don't await these promises
		// so they can run parallelized
		this.decryptPendingSubscriptions();
		this.decryptPendingMessages();

		// Mark Encryption client as ready
		this.ready = true;
	}

	// Stop Encryption client
	stop = () => {
		this.ready = false;
		this.privateKey = null;
		this.roomInstances = {};
	}

	// When a new participant join and request a new room encryption key
	provideRoomKeyToUser = async(keyId, roomId) => {
		const roomE2E = await this.getRoomInstance(roomId);

		if (!roomE2E) {
			return;
		}

		return roomE2E.provideKeyToUser(keyId);
	}

	// Persist keys on UserPreferences
	persistKeys = async(server, publicKey, privateKey) => {
		this.privateKey = await SimpleCrypto.RSA.importKey(EJSON.parse(privateKey));
		await UserPreferences.setStringAsync(`${ server }-${ E2E_PUBLIC_KEY }`, EJSON.stringify(publicKey));
		await UserPreferences.setStringAsync(`${ server }-${ E2E_PRIVATE_KEY }`, privateKey);
	}

	// Could not obtain public-private keypair from server.
	createKeys = async(userId, server) => {
		try {
			// Generate new keys
			const key = await SimpleCrypto.RSA.generateKeys(2048);

			// Cast these keys to the properly server format
			const publicKey = await SimpleCrypto.RSA.exportKey(key.public);
			const privateKey = await SimpleCrypto.RSA.exportKey(key.private);

			// Persist these new keys
			this.persistKeys(server, publicKey, EJSON.stringify(privateKey));

			// Create a password to encode the private key
			const password = await this.createRandomPassword(server);

			// Encode the private key
			const encodedPrivateKey = await this.encodePrivateKey(EJSON.stringify(privateKey), password, userId);

			// Send the new keys to the server
			await RocketChat.e2eSetUserPublicAndPrivateKeys(EJSON.stringify(publicKey), encodedPrivateKey);

			// Request e2e keys of all encrypted rooms
			await RocketChat.e2eRequestSubscriptionKeys();
		} catch {
			// Do nothing
		}
	}

	// Encode a private key before send it to the server
	encodePrivateKey = async(privateKey, password, userId) => {
		const masterKey = await this.generateMasterKey(password, userId);

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
		const masterKey = await this.generateMasterKey(password, userId);
		const [vector, cipherText] = splitVectorData(EJSON.parse(privateKey));

		const privKey = await SimpleCrypto.AES.decrypt(
			cipherText,
			masterKey,
			vector
		);

		return toString(privKey);
	}

	// Generate a user master key, this is based on userId and a password
	generateMasterKey = async(password, userId) => {
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
		// If rid is undefined
		if (!rid) {
			return;
		}

		// If Encryption client is not ready yet
		if (!this.ready) {
			return;
		}

		// If something goes wrong importing privateKey
		if (!this.privateKey) {
			return;
		}

		// Prevent find the sub again
		if (this.roomInstances[rid]?.ready) {
			return this.roomInstances[rid];
		}

		const db = database.active;
		const subCollection = db.collections.get('subscriptions');
		let sub;
		try {
			// Find the subscription
			sub = await subCollection.find(rid);
		} catch {
			// Subscription not found
			return;
		}

		// If this is not a direct or a private room
		if (!E2E_ROOM_TYPES[sub.t]) {
			return;
		}

		// If it's not encrypted and doesn't have a keyId
		// We should create a instance to rooms that are not encrypted at the moment
		// to decrypt old messages that are loaded after room encrypted be false
		if (!sub.encrypted && !sub.e2eKeyId) {
			return;
		}

		// If doesn't have a instance of this room
		if (!this.roomInstances[rid]) {
			this.roomInstances[rid] = new EncryptionRoom(sub);
		}

		const roomE2E = this.roomInstances[rid];

		// Start Encryption Room instance handshake
		await roomE2E.handshake(this.privateKey);

		return roomE2E;
	}

	// Logic to decrypt all pending messages/threads/threadMessages
	// after initialize the encryption client
	decryptPendingMessages = async(roomId) => {
		const db = database.active;

		const messagesCollection = db.collections.get('messages');
		const threadsCollection = db.collections.get('threads');
		const threadMessagesCollection = db.collections.get('thread_messages');

		// e2e status is 'pending' and message type is 'e2e'
		const whereClause = [
			Q.where('t', E2E_MESSAGE_TYPE),
			Q.where('e2e', E2E_STATUS.PENDING)
		];

		// decrypt messages of a room
		if (roomId) {
			whereClause.push(Q.where('rid', roomId));
		}

		try {
			// Find all messages/threads/threadsMessages that have pending e2e status
			const messagesToDecrypt = await messagesCollection.query(...whereClause).fetch();
			const threadsToDecrypt = await threadsCollection.query(...whereClause).fetch();
			const threadMessagesToDecrypt = await threadMessagesCollection.query(...whereClause).fetch();

			// Concat messages/threads/threadMessages
			let toDecrypt = [...messagesToDecrypt, ...threadsToDecrypt, ...threadMessagesToDecrypt];
			toDecrypt = await Promise.all(toDecrypt.map(async(message) => {
				const { rid, t, msg } = message;
				const newMessage = await this.decryptMessage({ rid, t, msg });
				if (message._hasPendingUpdate) {
					console.log(message);
					return;
				}
				return message.prepareUpdate(protectedFunction((m) => {
					Object.assign(m, newMessage);
				}));
			}));

			await db.action(async() => {
				await db.batch(...toDecrypt);
			});
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
			// Find all rooms that can have a lastMessage encrypted
			// If we select only encrypted rooms we can miss some room that changed their encrypted status
			const subsEncrypted = await subCollection.query(Q.where('e2e_key_id', Q.notEq(null))).fetch();
			// We can't do this on database level since lastMessage is not a database object
			const subsToDecrypt = subsEncrypted.filter(sub => (
				// Encrypted message
				sub?.lastMessage?.t === E2E_MESSAGE_TYPE
				// Message pending decrypt
				&& sub?.lastMessage?.e2e === E2E_STATUS.PENDING
			));
			await Promise.all(subsToDecrypt.map(async(sub) => {
				const { lastMessage } = sub;
				const newSub = await this.decryptSubscription({ lastMessage });
				if (sub._hasPendingUpdate) {
					console.log(sub);
					return;
				}
				return sub.prepareUpdate(protectedFunction((m) => {
					Object.assign(m, newSub);
				}));
			}));

			await db.action(async() => {
				await db.batch(...subsToDecrypt);
			});
		} catch {
			// Do nothing
		}
	}

	// Decrypt a subscription lastMessage
	decryptSubscription = async(subscription) => {
		// If the subscription doesn't have a lastMessage just return
		if (!subscription?.lastMessage) {
			return subscription;
		}

		const { lastMessage } = subscription;
		const { t, e2e } = lastMessage;

		// If it's not a encrypted message or was decrypted before
		if (t !== E2E_MESSAGE_TYPE || e2e === E2E_STATUS.DONE) {
			return subscription;
		}

		const { rid } = lastMessage;
		// If it doesn't have a ready room encryption instance yet and Encryption client is ready
		// let's create a instance based on the sub that will be decrypted
		if (!this.roomInstances[rid]?.ready && this.ready) {
			const db = database.active;
			const subCollection = db.collections.get('subscriptions');

			let sub = subscription;
			try {
				sub = await subCollection.find(rid);
			} catch {
				// Subscription not found
			}
			const E2EKey = sub?.E2EKey || subscription.E2EKey;

			// Create a new Room Encryption client
			const roomE2E = new EncryptionRoom(sub);
			// If sub doesn't have a E2EKey yet
			if (!E2EKey) {
				// Request this room key
				await roomE2E.requestRoomKey();
				// Return as a encrypted message
				return subscription;
			}

			// Set the instance
			this.roomInstances[rid] = roomE2E;
			// Do the handshake to get a ready client
			// this will prevent find the sub again
			// since maybe it doesn't exist on database yet
			await roomE2E.handshake(this.privateKey, E2EKey);
		}

		// Decrypt the message and send it back
		const decryptedMessage = await this.decryptMessage(lastMessage);
		return {
			...subscription,
			lastMessage: decryptedMessage
		};
	}

	// Encrypt a message
	encryptMessage = async(message) => {
		const roomE2E = await this.getRoomInstance(message.rid);

		if (!roomE2E) {
			return message;
		}

		return roomE2E.encrypt(message);
	}

	// Decrypt a message
	decryptMessage = async(message) => {
		const { t, e2e } = message;

		// Prevent create a new instance if this room was encrypted sometime ago
		if (t !== E2E_MESSAGE_TYPE || e2e === E2E_STATUS.DONE) {
			return message;
		}

		const roomE2E = await this.getRoomInstance(message.rid);

		if (!roomE2E) {
			return message;
		}

		return roomE2E.decrypt(message);
	}

	// Decrypt multiple messages
	decryptMessages = messages => Promise.all(messages.map(m => this.decryptMessage(m)))

	// Decrypt multiple subscriptions
	decryptSubscriptions = subscriptions => Promise.all(subscriptions.map(s => this.decryptSubscription(s)))
}

const encryption = new Encryption();
export default encryption;
