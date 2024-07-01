# Synthient Client Library

Node.js client for the Synthient API.

## Installation

To install the library:

```bash
npm install @synthient/synthient
```

or

```bash
yarn add @synthient/synthient
```

## Usage

### Initialization

To use the client, you need to initialize it with your API key. Optionally, you can set a default timeout and proxy configuration.

```javascript
const { Client } = require('@synthient/synthient');

const apiKey = 'your-private-key-here';
const client = new Client(apiKey, 5000, 'proxy-host', 8000);
```

or without a proxy or default timeout

```javascript
const client = new Client(apiKey);
```

### Methods

#### Lookup

Lookup a token and return its corresponding data.

```javascript
async function lookupToken() {
  try {
    const token = 'example-token';
    const response = await client.lookup(token);
    console.log('Lookup Response:', response);
  } catch (error) {
    console.error('Error during lookup:', error.message);
  }
}

lookupToken();
```

#### Visits

Lookup a session and return its corresponding visit data.

```javascript
async function getVisits() {
  try {
    const session = 'example-session';
    const response = await client.visits(session);
    console.log('Visit Response:', response);
  } catch (error) {
    console.error('Error during visits lookup:', error.message);
  }
}

getVisits();
```

#### Delete

Delete a token.

```javascript
async function deleteToken() {
  try {
    const token = 'token...';
    const response = await client.delete(token);
    console.log('Delete Response:', response);
  } catch (error) {
    console.error('Error during delete:', error.message);
  }
}

deleteToken();
```

### Utilities

The library includes utility functions for verifying tokens and determining actions based on risk levels.

#### Verify Token

Verify the validity of a token.

```javascript
const { verifyToken } = require('@synthient/synthient');

const isValid = verifyToken(lookupResponse, TokenType.METRICS);
console.log('Token is valid:', isValid);
```

#### Determine Action

Determine the action to take based on the lookup response and risk level.

```javascript
const { determineAction, TokenType, ActionType } = require('@synthient/synthient');

const action = determineAction(lookupResponse, TokenType.METRICS);
console.log('Action to take:', ActionType[action]);
```

## Models

### TokenType

The three types of tokens that can be issued:
- `METRICS`: Metrics token
- `SIGN`: Sign token, used for verifying the challenge.
- `STRICT`: Strict token, used for strict verification.

### ActionType

The actions to take based on the risk level:
- `ALLOW`: Allow the visitor to continue.
- `REDIRECT`: Redirect the visitor to a different page or have them perform another form of verification.
- `BLOCK`: Block the visitor from accessing.

### RiskLevel

The risk level of the visitor:
- `LOW`: Low risk.
- `MEDIUM`: Medium risk.
- `HIGH`: High risk.


Check `models.ts` for all the models used in the library. Or refer to the [API documentation](https://docs.synthient.com) for more information.


## Issues
For any issues or feature requests, please open an issue on the GitHub repository