'use strict';

// This is heavily influenced by
// https://github.com/oftn-oswg/oftn-bot/blob/master/lib/irc/client.js

const net = require('net');
const events = require('events');
const readline = require('readline');
const RejectedPromise = require('rejected-promise');
const debug = require('debug')('yairc');

class IRCBaseClient extends events.EventEmitter {
  constructor(options) {
    super();

    this.conn = null;
    this.peer = null;
    this.options = options;
  }

  connect(options) {
    this.conn = net.connect(this.options);

    if (this.options.encoding) {
      this.conn.setEncoding(this.options.encoding);
    }

    if (this.options.timeout) {
      this.conn.setTimeout(this.options.timeout);
    }

    return new RejectedPromise((resolve, reject) => {
      this.conn.on('connect', () => {
        this.peer = `${this.conn.remoteAddress}:${this.conn.remotePort}`;
        debug('Connected', this.peer);

        this.emit('connect');
        resolve(this);
      });

      this.conn.on('error', (err) => {
        debug('Error', err);
        this.emit('error', err);
        reject(err);
      });

      const rl = readline.createInterface({
        input: this.conn,
        output: null
      });

      rl.on('line', (data) => {
        this.onLine(data);
      });

      rl.on('close', () => {
        this.conn = null;
        this.emit('close');
      });
    });
  }

  sendRaw(msg) {
    debug('Sending', msg);
    this.conn.write(msg);
    this.conn.write('\r\n');
  }

  parseRawData(data) {
    const match = data.match(/(?:(:[^\s]+) )?([^\s]+) (.+)/);

    let params = match[3].match(/(.*?) ?:(.*)/);
    let message;

    if (params) {
      // Message segment
      message = params[2];

      // Params before message
      params = params[1].split(" ");
    } else {
      params = match[3].split(" ");
    }

    const prefix = match[1];
    let command = match[2];

    if ('0123456789'.includes(command[0]) && command.length === 3) {
      command = parseInt(command, 10);
    }

    return { prefix, command, params, message };
  }

  parseNames(rawList) {
    return rawList.trim().split(/\s+/g).map((nick) => {
      const info = { operator: false, voice: false, nick: nick };

      if (info.nick[0] === '@') {
        info.operator = true;
        info.nick = info.nick.substr(1);
      }

      if (info.nick[0] === '+') {
        info.voice = true;
        info.nick = info.nick.substr(1);
      }

      return info;
    });
  }

  parsePrefix(prefix) {
    const match = prefix.match(/^:(.*)!(\S+)@(\S+)/);
    if (match) {
      const [nick, user, host] = match;
      return { nick, user, host };
    } else {
      return null;
    }
  }

  onLine(data) {
    debug('Received data', data);

    return this.handleMessage(this.parseRawData(data));
  }

  handleMessage(message) {
    this.emit('rawMessage', message);
    this.emit('rawMessage:' + message.command, message);

    switch (message.command) {
      case 1: // RPL_WELCOME
        return this.emit('welcome');
      case 5: // RPL_BOUNCE
        return;
      case 331: // RPL_NOTOPIC
        return this.emit('channel-topic', {
          channel: message.params[1],
          topic: null
        });
      case 332: // RPL_TOPIC
        return this.emit('channel-topic', {
          channel: message.params[1],
          topic: message.message
        });
      case 353: // RPL_NAMREPLY
        return this.emit('channel-list', {
          channel: message.params[message.params.length - 1],
          names: this.parseNames(message.message)
        });
      case 'PING':
        return this.sendRaw(`PONG: ${message.message}`);
      case 'PONG':
        return;
      case 'NICK':
        return this.emit('nick-change', {
          oldnick: this.parsePrefix(message.prefix).nick,
          newnick: message.message
        });
      case 'JOIN':
        const user = this.parsePrefix(message.prefix).nick;
        if (message.params[0] === this.options.nick) {
          this.emit('join', { channel });
        }
        return this.emit('channel-join', {
          channel: message.message,
          nick: this.parsePrefix(message.prefix).nick
        });
      case 'TOPIC':
        return this.emit('channel-topic', {
          channel: message.params[0],
          topic: message.message
        });
      case 'PRIVMSG':
        if (message.params[0] === this.options.nick) {
          return this.emit('privmsg', {
            nick: this.parsePrefix(message.prefix).nick,
            message: message.message
          });
        } else {
          return this.emit('message', {
            nick: this.parsePrefix(message.prefix).nick,
            message: message.message,
            channel: message.params[0]
          });
        }
      case 'NOTICE':
        return this.emit('notice', { message: message.message });
      case 'PART':
        return this.emit('channel-leave', {
          channel: message.params[0],
          nick: this.parsePrefix(message.prefix).nick
        });
      case 'QUIT':
        return this.emit('quit', {
          nick: this.parsePrefix(message.prefix).nick
        });
      case 'MODE':
        const channel = message.params[0];
        const mode = message.params[1];
        const nick = message.params[2];
        if (!nick) return;

        return this.emit('channel-modechange', { channel, mode, nick });
      default:
        if (message.command >= 400 && message.command <= 600) {
          const e = new Error(`IRC ${message.command}: ${message.message}`);
          return this.emit('irc-error', e);
        }
    }
  }
}

class IRCClient extends IRCBaseClient {
  constructor(options) {
    super(options);

    this.on('connect', () => this.afterConnect());
  }

  afterConnect() {
    this.nick(this.options.nick);
    this.sendRaw(`USER ${this.options.user} 0 * : ${this.options.realname}`);

    this.emit('after-connect');
  }

  nick(n) {
    this.options.nick = n;
    this.sendRaw(`NICK ${this.options.nick}`);
  }

  join(channel, password) {
    this.sendRaw(`JOIN ${channel}${password ? ' :' + password: ''}`);
  }

  send(channel, message) {
    this.sendRaw(`PRIVMSG ${channel} :${message}`);
  }
}

module.exports = IRCClient;
module.exports.IRCBaseClient = IRCBaseClient;
