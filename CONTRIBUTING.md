# Contributing to Mokuro Reader

Thank you for your interest in contributing to Mokuro Reader!

## Development Environment Setup

### Node.js Version Requirement

**IMPORTANT: This project requires Node.js version 18.x**

The project is not compatible with Node.js 19+ or earlier versions. Please ensure you have the correct version installed before proceeding.

You can check your Node.js version with:

```bash
node --version
```

#### Using Node Version Manager (nvm)

We recommend using [nvm](https://github.com/nvm-sh/nvm) to manage your Node.js versions:

```bash
# Install Node.js 18
nvm install 18

# Use Node.js 18
nvm use 18
```

The project includes an `.nvmrc` file, so if you have nvm installed, you can simply run:

```bash
nvm use
```

### Installation

1. Clone the repository:

```bash
git clone https://github.com/ZXY101/mokuro-reader
cd mokuro-reader
```

2. Install dependencies:

```bash
npm install
```

3. Start the development server:

```bash
npm run dev
```

## Pull Request Process

1. Ensure your code adheres to the existing style.
2. Update the README.md with details of changes if applicable.
3. The PR should work with Node.js 18.x.
4. Your PR will be reviewed by the maintainers.

## Code of Conduct

Please be respectful and considerate of others when contributing to this project.
